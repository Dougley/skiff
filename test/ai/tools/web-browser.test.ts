import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "vitest";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

const { env } = await import("../../../src/config/env.js");
const { createWebTools } = await import("../../../src/ai/tools/web.js");

env.CLOUDFLARE_ACCOUNT_ID = "acct-1";
env.CLOUDFLARE_API_TOKEN = "cf-token";

type ToolContext = NonNullable<Parameters<typeof createWebTools>[0]>;
type ToolLike = {
  inputSchema: { parse: (value: unknown) => unknown };
  execute: (input: unknown, options: unknown) => Promise<unknown>;
};

const EXEC_OPTIONS = { toolCallId: "test-call", messages: [] };
const tools = createWebTools();

/** Runs a tool the way the SDK does: schema defaults applied, then execute. */
async function callTool(
  candidate: unknown,
  input: unknown
): Promise<Record<string, unknown>> {
  const tool = candidate as ToolLike;
  return (await tool.execute(
    tool.inputSchema.parse(input),
    EXEC_OPTIONS
  )) as Record<string, unknown>;
}

const browser = (input: unknown) => callTool(tools.browser_cdp, input);

// --- Cloudflare REST stub --------------------------------------------------

type Failure = { status: number; statusText: string };

type RouterOptions = {
  /** sessionId the create call hands back; null means "field omitted". */
  createdSessionId?: string | null;
  createdWsUrl?: string;
  tabs?: Array<Record<string, unknown>>;
  openedTab?: Record<string, unknown>;
  fail?: Partial<
    Record<"create" | "end" | "list" | "open" | "closeTab", Failure>
  >;
};

type Recorded = { url: string; method: string };

const realFetch = globalThis.fetch;

function stubFetch(
  handler: (url: URL, init: RequestInit | undefined) => Promise<Response>
): Recorded[] {
  const recorded: Recorded[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = String(input);
    recorded.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    return await handler(new URL(url), init);
  }) as typeof globalThis.fetch;
  return recorded;
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const fail = (f: Failure) =>
  new Response("error", { status: f.status, statusText: f.statusText });

/** Routes the handful of Cloudflare browser-rendering endpoints the tool uses. */
function cloudflareStub(options: RouterOptions = {}): Recorded[] {
  return stubFetch(async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    assert.equal(
      (init?.headers as Record<string, string> | undefined)?.Authorization,
      "Bearer cf-token"
    );

    if (path.endsWith("/devtools/browser") && method === "POST") {
      if (options.fail?.create) return fail(options.fail.create);
      const body: Record<string, unknown> = {
        webSocketDebuggerUrl: options.createdWsUrl ?? "ws://created.invalid/",
      };
      if (options.createdSessionId !== null) {
        body.sessionId = options.createdSessionId ?? "created-session";
      }
      return json(body);
    }
    if (path.endsWith("/json/list") && method === "GET") {
      if (options.fail?.list) return fail(options.fail.list);
      return json(options.tabs ?? []);
    }
    if (path.endsWith("/json/new") && method === "PUT") {
      if (options.fail?.open) return fail(options.fail.open);
      return json(options.openedTab ?? { id: "tab-new", url: url.search });
    }
    if (path.includes("/json/close/") && method === "DELETE") {
      if (options.fail?.closeTab) return fail(options.fail.closeTab);
      return json({});
    }
    if (method === "DELETE") {
      if (options.fail?.end) return fail(options.fail.end);
      return json({});
    }
    return new Response("unrouted", { status: 404, statusText: "Not Found" });
  });
}

// --- fake CDP endpoint -----------------------------------------------------

type CdpRequest = {
  id: number;
  method: string;
  params?: Record<string, unknown>;
};
type CdpServer = { url: string; requests: CdpRequest[] };

/** Sentinel: the reply handler already wrote to the socket itself. */
const HANDLED = Symbol("handled");
const cdpError = (message: string) => ({ __cdpError: message });

function defaultReply(req: CdpRequest, socket: WebSocket): unknown {
  switch (req.method) {
    case "Page.navigate":
      socket.send(
        JSON.stringify({ method: "Page.loadEventFired", params: { ts: 1 } })
      );
      return {};
    case "Page.getLayoutMetrics":
      return { cssContentSize: { width: 800.9, height: 600.4 } };
    case "Page.captureScreenshot":
      return { data: Buffer.from("png-bytes").toString("base64") };
    case "Runtime.evaluate":
      return { result: { value: { ok: true } } };
    default:
      return {};
  }
}

const openServers: WebSocketServer[] = [];

/** Starts a loopback CDP endpoint that answers commands via `reply`. */
async function startCdpServer(
  reply: (req: CdpRequest, socket: WebSocket) => unknown = defaultReply
): Promise<CdpServer> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  openServers.push(wss);
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));

  const requests: CdpRequest[] = [];
  wss.on("connection", (socket) => {
    socket.on("message", (data: RawData) => {
      const req = JSON.parse(data.toString()) as CdpRequest;
      requests.push(req);
      const out = reply(req, socket);
      if (out === HANDLED) return;
      if (out && typeof out === "object" && "__cdpError" in out) {
        const message = (out as { __cdpError: string }).__cdpError;
        socket.send(JSON.stringify({ id: req.id, error: { message } }));
        return;
      }
      socket.send(JSON.stringify({ id: req.id, result: out ?? {} }));
    });
  });

  const { port } = wss.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}/devtools/page/x`, requests };
}

/** A port nothing is listening on, for connection-failure tests. */
async function deadWsUrl(): Promise<string> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const { port } = wss.address() as AddressInfo;
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  return `ws://127.0.0.1:${port}/devtools/page/gone`;
}

const tabWith = (wsUrl: string, id = "tab-1") => ({
  id,
  type: "page",
  title: "Example",
  url: "https://example.test/",
  webSocketDebuggerUrl: wsUrl,
});

const paramsOf = (server: CdpServer, method: string) =>
  server.requests.find((r) => r.method === method)?.params ?? {};

afterEach(async () => {
  globalThis.fetch = realFetch;
  while (openServers.length > 0) {
    const wss = openServers.pop() as WebSocketServer;
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
});

// --- configuration & session lifecycle -------------------------------------
// These run in order: the module keeps one active session id in memory.

test("browser_cdp reports missing Cloudflare configuration", async () => {
  const token = env.CLOUDFLARE_API_TOKEN;
  env.CLOUDFLARE_API_TOKEN = undefined;
  const calls = cloudflareStub();

  try {
    const result = await browser({ action: "status" });
    assert.match(String(result.error), /missing CLOUDFLARE_ACCOUNT_ID/);
    assert.equal(calls.length, 0);
  } finally {
    env.CLOUDFLARE_API_TOKEN = token;
  }
});

test("status starts out with no active session", async () => {
  cloudflareStub();

  assert.deepEqual(await browser({ action: "status" }), {
    activeSessionId: null,
  });
});

test("session_start keeps the session alive for ten minutes by default", async () => {
  const calls = cloudflareStub({
    createdSessionId: "sess-a",
    createdWsUrl: "ws://cf.invalid/browser",
  });

  const result = await browser({ action: "session_start" });

  assert.equal(result.sessionId, "sess-a");
  assert.equal(result.webSocketDebuggerUrl, "ws://cf.invalid/browser");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(
    new URL(calls[0]?.url ?? "").searchParams.get("keep_alive"),
    "600000"
  );
  // the new session becomes the active one
  assert.deepEqual(await browser({ action: "status" }), {
    activeSessionId: "sess-a",
  });
});

test("session_start honours an explicit keep-alive", async () => {
  const calls = cloudflareStub({ createdSessionId: "sess-b" });

  await browser({ action: "session_start", keepAliveMs: 1500 });

  assert.equal(
    new URL(calls[0]?.url ?? "").searchParams.get("keep_alive"),
    "1500"
  );
});

test("a session_start without a sessionId is an error", async () => {
  cloudflareStub({ createdSessionId: null });

  const result = await browser({ action: "session_start" });

  assert.equal(result.error, "Cloudflare did not return a sessionId.");
  // the previous session stays active
  assert.deepEqual(await browser({ action: "status" }), {
    activeSessionId: "sess-b",
  });
});

test("a rejected session_start surfaces the Cloudflare status", async () => {
  cloudflareStub({
    fail: { create: { status: 502, statusText: "Bad Gateway" } },
  });

  const result = await browser({ action: "session_start" });

  assert.equal(
    result.error,
    "Browser CDP failed: Failed to create browser session: Bad Gateway"
  );
});

test("session_end on another session leaves the active one alone", async () => {
  const calls = cloudflareStub();

  const result = await browser({ action: "session_end", sessionId: "other" });

  assert.deepEqual(result, { ok: true, sessionId: "other" });
  assert.equal(calls[0]?.method, "DELETE");
  assert.ok(calls[0]?.url.endsWith("/browser/other"));
  assert.deepEqual(await browser({ action: "status" }), {
    activeSessionId: "sess-b",
  });
});

test("a rejected session_end surfaces the Cloudflare status", async () => {
  cloudflareStub({ fail: { end: { status: 500, statusText: "Boom" } } });

  const result = await browser({ action: "session_end", sessionId: "other" });

  assert.equal(
    result.error,
    "Browser CDP failed: Failed to close browser session: Boom"
  );
});

test("session_end without an id closes and forgets the active session", async () => {
  const calls = cloudflareStub();

  const result = await browser({ action: "session_end" });

  assert.deepEqual(result, { ok: true, sessionId: "sess-b" });
  assert.ok(calls[0]?.url.endsWith("/browser/sess-b"));
  assert.deepEqual(await browser({ action: "status" }), {
    activeSessionId: null,
  });
});

test("session_end with nothing to close explains itself", async () => {
  cloudflareStub();

  const result = await browser({ action: "session_end" });

  assert.equal(
    result.error,
    "No sessionId provided and no active session exists."
  );
});

test("an implicit session that comes back empty is an error", async () => {
  cloudflareStub({ createdSessionId: null });

  const result = await browser({ action: "tabs" });

  assert.equal(
    result.error,
    "Browser CDP failed: Cloudflare did not return a sessionId."
  );
});

// --- tabs ------------------------------------------------------------------

test("an action without a session opens one first", async () => {
  const calls = cloudflareStub({
    createdSessionId: "auto-session",
    tabs: [tabWith("ws://unused.invalid/", "tab-a"), { id: "tab-b" }],
  });

  const result = await browser({ action: "tabs" });

  assert.equal(result.sessionId, "auto-session");
  assert.deepEqual(result.tabs, [
    {
      id: "tab-a",
      type: "page",
      title: "Example",
      url: "https://example.test/",
    },
    { id: "tab-b", type: undefined, title: undefined, url: undefined },
  ]);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["POST", "GET"]
  );
  // and the created session is reused afterwards
  assert.deepEqual(await browser({ action: "status" }), {
    activeSessionId: "auto-session",
  });
});

test("a blank sessionId falls back to the active session", async () => {
  const calls = cloudflareStub({ tabs: [] });

  const result = await browser({ action: "tabs", sessionId: "   " });

  assert.equal(result.sessionId, "auto-session");
  // no session was created — the blank id did not count as one either
  assert.deepEqual(
    calls.map((c) => c.method),
    ["GET"]
  );
  assert.ok(calls[0]?.url.includes("/browser/auto-session/json/list"));
});

test("a non-array tab listing is treated as no tabs", async () => {
  stubFetch(async () => json({ unexpected: true }));

  const result = await browser({ action: "tabs", sessionId: "sess-1" });

  assert.deepEqual(result.tabs, []);
});

test("a rejected tab listing surfaces the Cloudflare status", async () => {
  cloudflareStub({
    fail: { list: { status: 503, statusText: "Unavailable" } },
  });

  const result = await browser({ action: "tabs", sessionId: "sess-1" });

  assert.equal(
    result.error,
    "Browser CDP failed: Failed to list tabs: Unavailable"
  );
});

test("open_tab needs a url", async () => {
  cloudflareStub();

  assert.equal(
    (await browser({ action: "open_tab", sessionId: "sess-1", url: "  " }))
      .error,
    "url is required for open_tab"
  );
});

test("open_tab passes the target url to Cloudflare", async () => {
  const calls = cloudflareStub({
    openedTab: { id: "tab-new", webSocketDebuggerUrl: "ws://cf.invalid/tab" },
  });

  const result = await browser({
    action: "open_tab",
    sessionId: "sess-1",
    url: "https://example.test/a b",
  });

  assert.equal(result.sessionId, "sess-1");
  assert.deepEqual(result.tab, {
    id: "tab-new",
    webSocketDebuggerUrl: "ws://cf.invalid/tab",
  });
  assert.equal(calls[0]?.method, "PUT");
  assert.equal(
    new URL(calls[0]?.url ?? "").searchParams.get("url"),
    "https://example.test/a b"
  );
});

test("a rejected open_tab surfaces the Cloudflare status", async () => {
  cloudflareStub({
    fail: { open: { status: 400, statusText: "Bad Request" } },
  });

  const result = await browser({
    action: "open_tab",
    sessionId: "sess-1",
    url: "https://example.test/",
  });

  assert.equal(
    result.error,
    "Browser CDP failed: Failed to open tab: Bad Request"
  );
});

test("close_tab needs a targetId", async () => {
  cloudflareStub();

  assert.equal(
    (await browser({ action: "close_tab", sessionId: "sess-1" })).error,
    "targetId is required for close_tab"
  );
});

test("close_tab closes the named tab", async () => {
  const calls = cloudflareStub();

  const result = await browser({
    action: "close_tab",
    sessionId: "sess-1",
    targetId: "tab-1",
  });

  assert.deepEqual(result, {
    ok: true,
    sessionId: "sess-1",
    targetId: "tab-1",
  });
  assert.ok(calls[0]?.url.endsWith("/json/close/tab-1"));
});

test("a rejected close_tab surfaces the Cloudflare status", async () => {
  cloudflareStub({
    fail: { closeTab: { status: 404, statusText: "Not Found" } },
  });

  const result = await browser({
    action: "close_tab",
    sessionId: "sess-1",
    targetId: "tab-1",
  });

  assert.equal(
    result.error,
    "Browser CDP failed: Failed to close tab: Not Found"
  );
});

// --- target resolution -----------------------------------------------------

test("a session with no tabs cannot be driven", async () => {
  cloudflareStub({ tabs: [] });

  const result = await browser({ action: "snapshot", sessionId: "sess-1" });

  assert.equal(
    result.error,
    "Browser CDP failed: No tabs are available in this browser session."
  );
});

test("an unknown targetId is rejected", async () => {
  cloudflareStub({ tabs: [tabWith("ws://unused.invalid/")] });

  const result = await browser({
    action: "snapshot",
    sessionId: "sess-1",
    targetId: "tab-missing",
  });

  assert.equal(result.error, "Browser CDP failed: Target tab was not found.");
});

test("a target without a debugger url cannot be driven", async () => {
  cloudflareStub({ tabs: [{ id: "tab-1", type: "page" }] });

  const result = await browser({ action: "snapshot", sessionId: "sess-1" });

  assert.equal(result.error, "Target does not expose a webSocketDebuggerUrl.");
});

test("a named targetId picks that tab out of the listing", async () => {
  const server = await startCdpServer();
  cloudflareStub({
    tabs: [
      { id: "tab-1", webSocketDebuggerUrl: "ws://unused.invalid/" },
      tabWith(server.url, "tab-2"),
    ],
  });

  const result = await browser({
    action: "evaluate",
    sessionId: "sess-1",
    targetId: "tab-2",
    expression: "1 + 1",
  });

  assert.equal(result.targetId, "tab-2");
  assert.deepEqual(result.value, { ok: true });
});

// --- navigation & snapshots ------------------------------------------------

test("navigate needs a url", async () => {
  cloudflareStub({ tabs: [tabWith("ws://unused.invalid/")] });

  const result = await browser({ action: "navigate", sessionId: "sess-1" });

  assert.equal(result.error, "url is required for navigate");
});

test("navigate drives the page and waits for the load event", async () => {
  const server = await startCdpServer();
  cloudflareStub({ tabs: [tabWith(server.url)] });

  const result = await browser({
    action: "navigate",
    sessionId: "sess-1",
    url: "https://example.test/next",
  });

  assert.deepEqual(result, {
    ok: true,
    sessionId: "sess-1",
    targetId: "tab-1",
    url: "https://example.test/next",
  });
  assert.deepEqual(
    server.requests.map((r) => r.method),
    ["Page.enable", "Page.navigate"]
  );
  assert.deepEqual(paramsOf(server, "Page.navigate"), {
    url: "https://example.test/next",
  });
});

test("snapshot returns the page text the evaluation produced", async () => {
  const server = await startCdpServer((req, socket) =>
    req.method === "Runtime.evaluate"
      ? { result: { value: "Title: Example\nURL: https://example.test/" } }
      : defaultReply(req, socket)
  );
  cloudflareStub({ tabs: [tabWith(server.url)] });

  const result = await browser({ action: "snapshot", sessionId: "sess-1" });

  assert.equal(result.snapshot, "Title: Example\nURL: https://example.test/");
  assert.equal(result.url, "https://example.test/");
  assert.equal(result.targetId, "tab-1");
  const expression = String(
    (paramsOf(server, "Runtime.evaluate") as { expression?: string }).expression
  );
  assert.match(expression, /document\.body\?\.innerText/);
  assert.match(expression, /a\[href\]/);
});

test("a snapshot that yields no string comes back empty", async () => {
  const server = await startCdpServer((req, socket) =>
    req.method === "Runtime.evaluate"
      ? { result: { value: 42 } }
      : defaultReply(req, socket)
  );
  cloudflareStub({ tabs: [tabWith(server.url)] });

  const result = await browser({ action: "snapshot", sessionId: "sess-1" });

  assert.equal(result.snapshot, "");
});

// --- screenshots -----------------------------------------------------------

test("a screenshot without an attachment sink returns base64", async () => {
  const server = await startCdpServer();
  cloudflareStub({ tabs: [tabWith(server.url)] });

  const result = await browser({ action: "screenshot", sessionId: "sess-1" });

  assert.equal(result.mimeType, "image/png");
  assert.equal(
    Buffer.from(String(result.imageBase64), "base64").toString(),
    "png-bytes"
  );
  assert.deepEqual(paramsOf(server, "Page.captureScreenshot"), {
    format: "png",
    captureBeyondViewport: false,
  });
});

test("a full-page jpeg screenshot clips to the measured content size", async () => {
  const server = await startCdpServer();
  cloudflareStub({ tabs: [tabWith(server.url)] });

  const result = await browser({
    action: "screenshot",
    sessionId: "sess-1",
    fullPage: true,
    imageType: "jpeg",
    quality: 87,
  });

  assert.equal(result.mimeType, "image/jpeg");
  assert.deepEqual(paramsOf(server, "Page.captureScreenshot"), {
    format: "jpeg",
    captureBeyondViewport: true,
    quality: 87,
    clip: { x: 0, y: 0, width: 800, height: 600, scale: 1 },
  });
});

test("a screenshot is attached to the reply instead of the model context", async () => {
  const server = await startCdpServer();
  cloudflareStub({ tabs: [tabWith(server.url)] });
  const attachments: Array<{ name: string; data: Buffer }> = [];
  const ctx = {
    client: {},
    guildId: null,
    channelId: "chan",
    attachments,
  } as unknown as ToolContext;

  const result = await callTool(createWebTools(ctx).browser_cdp, {
    action: "screenshot",
    sessionId: "sess-1",
    imageType: "jpeg",
  });

  assert.equal(result.attached, true);
  assert.equal(result.imageBase64, undefined);
  assert.equal(attachments.length, 1);
  assert.match(String(result.filename), /^screenshot-\d+\.jpg$/);
  assert.equal(attachments[0]?.name, result.filename);
  assert.equal(attachments[0]?.data.toString(), "png-bytes");
});

test("screenshots stop once the reply is full", async () => {
  const server = await startCdpServer();
  cloudflareStub({ tabs: [tabWith(server.url)] });
  const attachments = Array.from({ length: 9 }, (_, i) => ({
    name: `f${i}.png`,
    data: Buffer.from("x"),
  }));
  const ctx = {
    client: {},
    guildId: null,
    channelId: "chan",
    attachments,
  } as unknown as ToolContext;

  const result = await callTool(createWebTools(ctx).browser_cdp, {
    action: "screenshot",
    sessionId: "sess-1",
  });

  assert.match(String(result.error), /Attachment limit reached/);
  assert.equal(attachments.length, 9);
});

test("a screenshot without image data is an error", async () => {
  const server = await startCdpServer((req, socket) =>
    req.method === "Page.captureScreenshot" ? {} : defaultReply(req, socket)
  );
  cloudflareStub({ tabs: [tabWith(server.url)] });

  const result = await browser({ action: "screenshot", sessionId: "sess-1" });

  assert.equal(
    result.error,
    "Browser CDP failed: Screenshot did not return image data."
  );
});

// --- evaluate / click / type / press ---------------------------------------

test("evaluate needs an expression", async () => {
  cloudflareStub({ tabs: [tabWith("ws://unused.invalid/")] });

  const result = await browser({ action: "evaluate", sessionId: "sess-1" });

  assert.equal(result.error, "expression is required for evaluate");
});

test("evaluate returns the page-side value", async () => {
  const server = await startCdpServer((req, socket) =>
    req.method === "Runtime.evaluate"
      ? { result: { value: { count: 3 } } }
      : defaultReply(req, socket)
  );
  cloudflareStub({ tabs: [tabWith(server.url)] });

  const result = await browser({
    action: "evaluate",
    sessionId: "sess-1",
    expression: "  document.links.length  ",
  });

  assert.deepEqual(result.value, { count: 3 });
  assert.deepEqual(paramsOf(server, "Runtime.evaluate"), {
    expression: "document.links.length",
    awaitPromise: true,
    returnByValue: true,
  });
});

test("a page-side exception is surfaced rather than swallowed", async () => {
  const server = await startCdpServer((req, socket) =>
    req.method === "Runtime.evaluate"
      ? {
          result: {},
          exceptionDetails: {
            text: "Uncaught",
            exception: { description: "ReferenceError: nope is not defined" },
          },
        }
      : defaultReply(req, socket)
  );
  cloudflareStub({ tabs: [tabWith(server.url)] });

  const result = await browser({
    action: "evaluate",
    sessionId: "sess-1",
    expression: "nope()",
  });

  assert.equal(
    result.error,
    "Browser CDP failed: Evaluation failed: ReferenceError: nope is not defined"
  );
});

test("an exception with no description falls back to its text", async () => {
  const server = await startCdpServer((req, socket) =>
    req.method === "Runtime.evaluate"
      ? { result: {}, exceptionDetails: { text: "Uncaught SyntaxError" } }
      : defaultReply(req, socket)
  );
  cloudflareStub({ tabs: [tabWith(server.url)] });

  const result = await browser({
    action: "evaluate",
    sessionId: "sess-1",
    expression: "(",
  });

  assert.equal(
    result.error,
    "Browser CDP failed: Evaluation failed: Uncaught SyntaxError"
  );
});

test("click needs a selector", async () => {
  cloudflareStub({ tabs: [tabWith("ws://unused.invalid/")] });

  assert.equal(
    (await browser({ action: "click", sessionId: "sess-1", selector: " " }))
      .error,
    "selector is required for click"
  );
});

test("click runs a querySelector click in the page", async () => {
  const server = await startCdpServer();
  cloudflareStub({ tabs: [tabWith(server.url)] });

  const result = await browser({
    action: "click",
    sessionId: "sess-1",
    selector: "button.primary",
  });

  assert.deepEqual(result.result, { ok: true });
  const expression = String(
    (paramsOf(server, "Runtime.evaluate") as { expression?: string }).expression
  );
  assert.match(expression, /document\.querySelector\("button\.primary"\)/);
  assert.match(expression, /el\.click\(\)/);
});

test("type needs both a selector and text", async () => {
  cloudflareStub({ tabs: [tabWith("ws://unused.invalid/")] });

  assert.equal(
    (await browser({ action: "type", sessionId: "sess-1" })).error,
    "selector is required for type"
  );
  assert.equal(
    (await browser({ action: "type", sessionId: "sess-1", selector: "#q" }))
      .error,
    "text is required for type"
  );
});

test("type sets the value and fires input and change", async () => {
  const server = await startCdpServer();
  cloudflareStub({ tabs: [tabWith(server.url)] });

  const result = await browser({
    action: "type",
    sessionId: "sess-1",
    selector: "#q",
    text: 'hello "world"',
  });

  assert.deepEqual(result.result, { ok: true });
  const expression = String(
    (paramsOf(server, "Runtime.evaluate") as { expression?: string }).expression
  );
  assert.match(expression, /el\.value = "hello \\"world\\""/);
  assert.match(expression, /new Event\("input", \{ bubbles: true \}\)/);
  assert.match(expression, /new Event\("change", \{ bubbles: true \}\)/);
});

test("press needs a key", async () => {
  cloudflareStub({ tabs: [tabWith("ws://unused.invalid/")] });

  assert.equal(
    (await browser({ action: "press", sessionId: "sess-1", key: "  " })).error,
    "key is required for press"
  );
});

test("press dispatches keydown and keyup on the document", async () => {
  const server = await startCdpServer();
  cloudflareStub({ tabs: [tabWith(server.url)] });

  const result = await browser({
    action: "press",
    sessionId: "sess-1",
    key: "Enter",
  });

  assert.deepEqual(result.result, { ok: true });
  const expression = String(
    (paramsOf(server, "Runtime.evaluate") as { expression?: string }).expression
  );
  assert.match(expression, /key: "Enter"/);
  assert.match(expression, /keydown/);
  assert.match(expression, /keyup/);
});

// --- CDP transport ---------------------------------------------------------

test("a CDP command error is reported back to the caller", async () => {
  const server = await startCdpServer((req, socket) =>
    req.method === "Runtime.evaluate"
      ? cdpError("Cannot find context with specified id")
      : defaultReply(req, socket)
  );
  cloudflareStub({ tabs: [tabWith(server.url)] });

  const result = await browser({
    action: "evaluate",
    sessionId: "sess-1",
    expression: "1",
  });

  assert.equal(
    result.error,
    "Browser CDP failed: Cannot find context with specified id"
  );
});

test("frames that are not command replies are ignored", async () => {
  const server = await startCdpServer((req, socket) => {
    if (req.method !== "Runtime.evaluate") return defaultReply(req, socket);
    socket.send("this is not json");
    socket.send(JSON.stringify({ id: 9999, result: { stray: true } }));
    socket.send(JSON.stringify({ method: "Network.requestWillBeSent" }));
    socket.send(
      JSON.stringify({ id: req.id, result: { result: { value: 7 } } })
    );
    return HANDLED;
  });
  cloudflareStub({ tabs: [tabWith(server.url)] });

  const result = await browser({
    action: "evaluate",
    sessionId: "sess-1",
    expression: "7",
  });

  assert.equal(result.value, 7);
});

test("an unreachable debugger endpoint fails the action", async () => {
  cloudflareStub({ tabs: [tabWith(await deadWsUrl())] });

  const result = await browser({ action: "snapshot", sessionId: "sess-1" });

  assert.match(String(result.error), /^Browser CDP failed: /);
});

test("an action the tool does not implement is refused", async () => {
  const server = await startCdpServer();
  cloudflareStub({ tabs: [tabWith(server.url)] });

  // bypasses the input schema, which would normally reject the action outright
  const result = (await (tools.browser_cdp as unknown as ToolLike).execute(
    {
      action: "teleport",
      sessionId: "sess-1",
      fullPage: false,
      imageType: "png",
    },
    EXEC_OPTIONS
  )) as Record<string, unknown>;

  assert.equal(result.error, "Unsupported action: teleport");
});
