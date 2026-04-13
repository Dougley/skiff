import { tool } from "ai";
import WebSocket from "ws";
import { z } from "zod";
import { env } from "../env/index.js";

// Brave Search rate limiter — 1 request per second sliding window.
// Queues concurrent calls so they execute sequentially with the required gap.
const braveRateLimit = {
  lastRequestTime: 0,
  queue: Promise.resolve(),
};

async function throttledBraveFetch(
  url: string,
  init: RequestInit
): Promise<Response> {
  braveRateLimit.queue = braveRateLimit.queue.then(async () => {
    const now = Date.now();
    const elapsed = now - braveRateLimit.lastRequestTime;
    const minGap = 1000; // 1 second
    if (elapsed < minGap) {
      await new Promise((r) => setTimeout(r, minGap - elapsed));
    }
    braveRateLimit.lastRequestTime = Date.now();
  });

  return braveRateLimit.queue.then(() => fetch(url, init));
}

type BraveSearchResponse = {
  web?: {
    results?: Array<{
      title?: string;
      description?: string;
      url?: string;
    }>;
  };
};

type CloudflareMarkdownResponse = {
  success?: boolean;
  result?: string;
  errors?: Array<{ message?: string }>;
};

type CloudflareTabTarget = {
  id?: string;
  type?: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
};

type CloudflareSessionResponse = {
  sessionId?: string;
  webSocketDebuggerUrl?: string;
};

type CdpResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
};

type CdpEvent = {
  method: string;
  params?: unknown;
};

type CdpSendFn = (
  method: string,
  params?: Record<string, unknown>
) => Promise<unknown>;

type CdpWaitForEventFn = (method: string, timeoutMs?: number) => Promise<unknown>;

const CDP_TIMEOUT_MS = 30_000;

const cloudflareBrowserState: { sessionId: string | null } = {
  sessionId: null,
};

const DEFAULT_CF_BROWSER_KEEP_ALIVE_MS = 10 * 60 * 1000;

function getCloudflareBrowserApiBase(): string {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/devtools/browser`;
}

function getCloudflareAuthHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
  };
}

function hasCloudflareBrowserConfig(): boolean {
  return Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN);
}

async function createCloudflareBrowserSession(
  keepAliveMs = DEFAULT_CF_BROWSER_KEEP_ALIVE_MS
): Promise<CloudflareSessionResponse> {
  const url = `${getCloudflareBrowserApiBase()}?keep_alive=${Math.max(
    1,
    Math.floor(keepAliveMs)
  )}`;
  const response = await fetch(url, {
    method: "POST",
    headers: getCloudflareAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Failed to create browser session: ${response.statusText}`);
  }
  return (await response.json()) as CloudflareSessionResponse;
}

async function closeCloudflareBrowserSession(sessionId: string): Promise<void> {
  const response = await fetch(
    `${getCloudflareBrowserApiBase()}/${encodeURIComponent(sessionId)}`,
    {
      method: "DELETE",
      headers: getCloudflareAuthHeaders(),
    }
  );
  if (!response.ok) {
    throw new Error(`Failed to close browser session: ${response.statusText}`);
  }
}

async function listCloudflareTabs(sessionId: string): Promise<CloudflareTabTarget[]> {
  const response = await fetch(
    `${getCloudflareBrowserApiBase()}/${encodeURIComponent(sessionId)}/json/list`,
    {
      method: "GET",
      headers: getCloudflareAuthHeaders(),
    }
  );
  if (!response.ok) {
    throw new Error(`Failed to list tabs: ${response.statusText}`);
  }
  const data = (await response.json()) as unknown;
  return Array.isArray(data) ? (data as CloudflareTabTarget[]) : [];
}

async function openCloudflareTab(
  sessionId: string,
  targetUrl: string
): Promise<CloudflareTabTarget> {
  const response = await fetch(
    `${getCloudflareBrowserApiBase()}/${encodeURIComponent(
      sessionId
    )}/json/new?url=${encodeURIComponent(targetUrl)}`,
    {
      method: "PUT",
      headers: getCloudflareAuthHeaders(),
    }
  );
  if (!response.ok) {
    throw new Error(`Failed to open tab: ${response.statusText}`);
  }
  return (await response.json()) as CloudflareTabTarget;
}

async function closeCloudflareTab(sessionId: string, targetId: string): Promise<void> {
  const response = await fetch(
    `${getCloudflareBrowserApiBase()}/${encodeURIComponent(
      sessionId
    )}/json/close/${encodeURIComponent(targetId)}`,
    {
      method: "DELETE",
      headers: getCloudflareAuthHeaders(),
    }
  );
  if (!response.ok) {
    throw new Error(`Failed to close tab: ${response.statusText}`);
  }
}

function rawWsDataToString(data: WebSocket.RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

async function withCdpSocket<T>(
  wsUrl: string,
  fn: (send: CdpSendFn, waitForEvent: CdpWaitForEventFn) => Promise<T>
): Promise<T> {
  const ws = new WebSocket(wsUrl, {
    handshakeTimeout: 10_000,
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  const eventListeners = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

  const closeWithError = (err: Error) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    for (const l of eventListeners.values()) l.reject(err);
    eventListeners.clear();
    try {
      ws.close();
    } catch {
      // ignore
    }
  };

  ws.on("message", (data) => {
    let parsed: CdpResponse | CdpEvent;
    try {
      parsed = JSON.parse(rawWsDataToString(data)) as CdpResponse | CdpEvent;
    } catch {
      return;
    }

    // command response — has a numeric id
    if (typeof (parsed as CdpResponse).id === "number") {
      const res = parsed as CdpResponse;
      const pendingCall = pending.get(res.id as number);
      if (!pendingCall) return;
      pending.delete(res.id as number);
      if (res.error?.message) {
        pendingCall.reject(new Error(res.error.message));
      } else {
        pendingCall.resolve(res.result);
      }
      return;
    }

    // event — has a method string, no id
    const event = parsed as CdpEvent;
    if (typeof event.method === "string") {
      const listener = eventListeners.get(event.method);
      if (listener) {
        eventListeners.delete(event.method);
        listener.resolve(event.params);
      }
    }
  });

  ws.on("error", (error) => {
    closeWithError(error instanceof Error ? error : new Error(String(error)));
  });

  const openPromise = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
    ws.once("close", () => reject(new Error("CDP socket closed before open")));
  });

  await openPromise;

  const send: CdpSendFn = (method, params) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return Promise.race([
      new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP command timed out: ${method}`));
        }, CDP_TIMEOUT_MS)
      ),
    ]);
  };

  const waitForEvent: CdpWaitForEventFn = (method, timeoutMs = CDP_TIMEOUT_MS) =>
    Promise.race([
      new Promise<unknown>((resolve, reject) => {
        eventListeners.set(method, { resolve, reject });
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          eventListeners.delete(method);
          reject(new Error(`CDP event timed out: ${method}`));
        }, timeoutMs)
      ),
    ]);

  try {
    return await fn(send, waitForEvent);
  } finally {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
}

function resolveSessionId(sessionId?: string): string | null {
  return sessionId?.trim() || cloudflareBrowserState.sessionId;
}

async function ensureSessionId(sessionId?: string): Promise<string> {
  const resolved = resolveSessionId(sessionId);
  if (resolved) return resolved;

  const created = await createCloudflareBrowserSession();
  if (!created.sessionId) {
    throw new Error("Cloudflare did not return a sessionId.");
  }
  cloudflareBrowserState.sessionId = created.sessionId;
  return created.sessionId;
}

async function resolveTarget(sessionId: string, targetId?: string): Promise<CloudflareTabTarget> {
  const tabs = await listCloudflareTabs(sessionId);
  if (tabs.length === 0) {
    throw new Error("No tabs are available in this browser session.");
  }
  if (targetId) {
    const found = tabs.find((tab) => tab.id === targetId);
    if (!found) {
      throw new Error("Target tab was not found.");
    }
    return found;
  }
  return tabs[0] as CloudflareTabTarget;
}

async function navigateTarget(wsUrl: string, targetUrl: string): Promise<void> {
  await withCdpSocket(wsUrl, async (send, waitForEvent) => {
    await send("Page.enable");
    // register listener before navigate so we can't miss a fast load
    const loaded = waitForEvent("Page.loadEventFired");
    await send("Page.navigate", { url: targetUrl });
    await loaded;
  });
}

async function captureTextSnapshot(wsUrl: string): Promise<string> {
  const expression = [
    "(() => {",
    '  const title = document.title || "";',
    "  const currentUrl = location.href;",
    '  const text = (document.body?.innerText || "").trim().slice(0, 12000);',
    '  const links = Array.from(document.querySelectorAll("a[href]")).slice(0, 25).map((a) => {',
    '    const href = a.getAttribute("href") || "";',
    '    const label = (a.textContent || "").trim();',
    '    return label ? (label + " -> " + href) : href;',
    "  });",
    "  return [",
    '    "Title: " + title,',
    '    "URL: " + currentUrl,',
    '    "",',
    '    "Text:",',
    "    text,",
    '    "",',
    '    "Links:",',
    '    links.join("\\n")',
    '  ].join("\\n");',
    "})()",
  ].join("\n");

  const result = await withCdpSocket(wsUrl, async (send) => {
    await send("Runtime.enable");
    return await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
  });

  const value = (result as { result?: { value?: unknown } })?.result?.value;
  return typeof value === "string" ? value : "";
}

async function captureScreenshotBase64(params: {
  wsUrl: string;
  fullPage?: boolean;
  format?: "png" | "jpeg";
  quality?: number;
}): Promise<string> {
  const { wsUrl, fullPage, format, quality } = params;
  const result = await withCdpSocket(wsUrl, async (send) => {
    await send("Page.enable");

    const screenshotParams: Record<string, unknown> = {
      format: format ?? "png",
      captureBeyondViewport: Boolean(fullPage),
    };

    if ((format ?? "png") === "jpeg" && typeof quality === "number") {
      screenshotParams.quality = Math.max(0, Math.min(100, Math.floor(quality)));
    }

    if (fullPage) {
      const metrics = (await send("Page.getLayoutMetrics")) as {
        cssContentSize?: { width?: number; height?: number };
      };
      const width = Math.max(1, Math.floor(metrics.cssContentSize?.width ?? 1280));
      const height = Math.max(1, Math.floor(metrics.cssContentSize?.height ?? 720));
      screenshotParams.clip = {
        x: 0,
        y: 0,
        width,
        height,
        scale: 1,
      };
    }

    return await send("Page.captureScreenshot", screenshotParams);
  });

  const data = (result as { data?: unknown })?.data;
  if (typeof data !== "string") {
    throw new Error("Screenshot did not return image data.");
  }
  return data;
}

async function evaluateInTarget(wsUrl: string, expression: string): Promise<unknown> {
  const result = await withCdpSocket(wsUrl, async (send) => {
    await send("Runtime.enable");
    return await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
  });

  return (result as { result?: { value?: unknown } })?.result?.value;
}

export const createWebTools = () => {
  return {
    web_search: tool({
      description:
        "Perform a web search using the Brave Search API. Use this tool to find up-to-date information on any topic. The input should be a search query string, and the output will include the top search results with their titles, snippets, and URLs.",
      inputSchema: z.object({
        query: z.string().describe("The search query to perform."),
      }),
      execute: async ({ query }) => {
        if (!env.BRAVE_SEARCH_API_KEY) {
          return {
            error:
              "Web search is not configured (missing BRAVE_SEARCH_API_KEY).",
          };
        }
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
          query
        )}&count=10`;
        const init = {
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": env.BRAVE_SEARCH_API_KEY as string,
          },
        };
        let response = await throttledBraveFetch(url, init);
        // Retry once on rate limit, respecting the reset header.
        // X-RateLimit-Reset is seconds-remaining and may be compound ("1, 2592000")
        // so parse only the first (shortest) window to get the relevant delay.
        if (response.status === 429) {
          const reset = response.headers.get("X-RateLimit-Reset");
          const firstReset = reset ? Number(reset.split(",")[0]?.trim()) : NaN;
          const delay = Number.isFinite(firstReset)
            ? Math.min(firstReset, 5) * 1000
            : 2000;
          await new Promise((r) => setTimeout(r, delay));
          response = await throttledBraveFetch(url, init);
        }
        if (!response.ok) {
          return { error: `Brave Search API error: ${response.statusText}` };
        }
        const data = (await response.json()) as BraveSearchResponse;
        const results = (data.web?.results ?? []).map((result) => ({
          title: result.title,
          snippet: result.description,
          url: result.url,
        }));
        return { results };
      },
    }),
    fetch_url: tool({
      description:
        "Fetch a web page's content. By default, this tool will try to retrieve Markdown-formatted content from the URL, but it can also return raw HTML if specified. Use this tool when you need to access the full text of a web page or specific information that may not be included in search results.",
      inputSchema: z.object({
        url: z.url().describe("The URL of the web page to fetch."),
        format: z
          .enum(["markdown", "html"])
          .default("markdown")
          .describe(
            "The format to return the content in. 'markdown' will attempt to extract and format the main content, while 'html' will return the raw HTML of the page."
          ),
      }),
      execute: async ({ url, format }) => {
        if (!/^https?:\/\//.test(url)) {
          return {
            error:
              "Invalid URL format. URL must start with http:// or https://",
          };
        }
        if (format === "markdown") {
          if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
            return {
              error:
                "Markdown fetch is not configured (missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN).",
              hint: "Set both environment variables or use format='html'.",
            };
          }

          try {
            const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/markdown`;
            const response = await fetch(endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
              },
              body: JSON.stringify({ url }),
            });
            if (!response.ok) {
              return {
                error: `Fetch Markdown error: ${response.statusText}`,
                hint: "Try fetching as html instead by setting format to 'html'.",
              };
            }
            const data = (await response.json()) as CloudflareMarkdownResponse;
            if (!data.success || typeof data.result !== "string") {
              const reason = data.errors?.[0]?.message || "Unknown error";
              return {
                error: `Fetch Markdown failed: ${reason}`,
                hint: "Try fetching as html instead by setting format to 'html'.",
              };
            }
            return { content: data.result };
          } catch (err) {
            return {
              error: `Fetch Markdown failed: ${
                err instanceof Error ? err.message : "Unknown error"
              }`,
            };
          }
        }
        try {
          const response = await fetch(url);
          if (!response.ok) {
            return { error: `Fetch URL error: ${response.statusText}` };
          }
          const content = await response.text();
          return { content };
        } catch (err) {
          return {
            error: `Fetch URL failed: ${
              err instanceof Error ? err.message : "Unknown error"
            }`,
          };
        }
      },
    }),
    browser_cdp: tool({
      description:
        "Control Cloudflare Browser Rendering via CDP. Supports browser session lifecycle, tab operations, navigation, snapshots, screenshots, and simple UI actions.",
      inputSchema: z.object({
        action: z.enum([
          "session_start",
          "session_end",
          "status",
          "tabs",
          "open_tab",
          "close_tab",
          "navigate",
          "snapshot",
          "screenshot",
          "evaluate",
          "click",
          "type",
          "press",
        ]),
        sessionId: z.string().optional(),
        keepAliveMs: z.number().int().positive().optional(),
        targetId: z.string().optional(),
        url: z.string().optional(),
        expression: z.string().optional(),
        selector: z.string().optional(),
        text: z.string().optional(),
        key: z.string().optional(),
        fullPage: z.boolean().default(false),
        imageType: z.enum(["png", "jpeg"]).default("png"),
        quality: z.number().int().min(0).max(100).optional(),
      }),
      execute: async ({
        action,
        sessionId,
        keepAliveMs,
        targetId,
        url,
        expression,
        selector,
        text,
        key,
        fullPage,
        imageType,
        quality,
      }) => {
        if (!hasCloudflareBrowserConfig()) {
          return {
            error:
              "Browser CDP is not configured (missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN).",
          };
        }

        try {
          if (action === "session_start") {
            const created = await createCloudflareBrowserSession(keepAliveMs);
            if (!created.sessionId) {
              return { error: "Cloudflare did not return a sessionId." };
            }
            cloudflareBrowserState.sessionId = created.sessionId;
            return {
              sessionId: created.sessionId,
              webSocketDebuggerUrl: created.webSocketDebuggerUrl,
            };
          }

          if (action === "session_end") {
            const resolvedSessionId = resolveSessionId(sessionId);
            if (!resolvedSessionId) {
              return { error: "No sessionId provided and no active session exists." };
            }
            await closeCloudflareBrowserSession(resolvedSessionId);
            if (cloudflareBrowserState.sessionId === resolvedSessionId) {
              cloudflareBrowserState.sessionId = null;
            }
            return { ok: true, sessionId: resolvedSessionId };
          }

          if (action === "status") {
            return {
              activeSessionId: cloudflareBrowserState.sessionId,
            };
          }

          const activeSessionId = await ensureSessionId(sessionId);

          if (action === "tabs") {
            const tabs = await listCloudflareTabs(activeSessionId);
            return {
              sessionId: activeSessionId,
              tabs: tabs.map((tab) => ({
                id: tab.id,
                type: tab.type,
                title: tab.title,
                url: tab.url,
              })),
            };
          }

          if (action === "open_tab") {
            const targetUrl = url?.trim();
            if (!targetUrl) {
              return { error: "url is required for open_tab" };
            }
            const tab = await openCloudflareTab(activeSessionId, targetUrl);
            return { sessionId: activeSessionId, tab };
          }

          if (action === "close_tab") {
            const id = targetId?.trim();
            if (!id) {
              return { error: "targetId is required for close_tab" };
            }
            await closeCloudflareTab(activeSessionId, id);
            return { ok: true, sessionId: activeSessionId, targetId: id };
          }

          const target = await resolveTarget(activeSessionId, targetId);
          const wsUrl = target.webSocketDebuggerUrl;
          if (!wsUrl) {
            return { error: "Target does not expose a webSocketDebuggerUrl." };
          }

          if (action === "navigate") {
            const targetUrl = url?.trim();
            if (!targetUrl) {
              return { error: "url is required for navigate" };
            }
            await navigateTarget(wsUrl, targetUrl);
            return {
              ok: true,
              sessionId: activeSessionId,
              targetId: target.id,
              url: targetUrl,
            };
          }

          if (action === "snapshot") {
            const snapshot = await captureTextSnapshot(wsUrl);
            return {
              sessionId: activeSessionId,
              targetId: target.id,
              url: target.url,
              snapshot,
            };
          }

          if (action === "screenshot") {
            const data = await captureScreenshotBase64({
              wsUrl,
              fullPage,
              format: imageType,
              quality,
            });
            return {
              sessionId: activeSessionId,
              targetId: target.id,
              mimeType: imageType === "jpeg" ? "image/jpeg" : "image/png",
              imageBase64: data,
            };
          }

          if (action === "evaluate") {
            const source = expression?.trim();
            if (!source) {
              return { error: "expression is required for evaluate" };
            }
            const value = await evaluateInTarget(wsUrl, source);
            return {
              sessionId: activeSessionId,
              targetId: target.id,
              value,
            };
          }

          if (action === "click") {
            const css = selector?.trim();
            if (!css) {
              return { error: "selector is required for click" };
            }
            const value = await evaluateInTarget(
              wsUrl,
              `(() => {
                const el = document.querySelector(${JSON.stringify(css)});
                if (!el) return { ok: false, reason: "Element not found" };
                (el as HTMLElement).click();
                return { ok: true };
              })()`
            );
            return { sessionId: activeSessionId, targetId: target.id, result: value };
          }

          if (action === "type") {
            const css = selector?.trim();
            if (!css) {
              return { error: "selector is required for type" };
            }
            if (typeof text !== "string") {
              return { error: "text is required for type" };
            }
            const value = await evaluateInTarget(
              wsUrl,
              `(() => {
                const el = document.querySelector(${JSON.stringify(css)});
                if (!el) return { ok: false, reason: "Element not found" };
                const target = el as HTMLInputElement | HTMLTextAreaElement;
                target.focus();
                target.value = ${JSON.stringify(text)};
                target.dispatchEvent(new Event("input", { bubbles: true }));
                target.dispatchEvent(new Event("change", { bubbles: true }));
                return { ok: true };
              })()`
            );
            return { sessionId: activeSessionId, targetId: target.id, result: value };
          }

          if (action === "press") {
            const keyValue = key?.trim();
            if (!keyValue) {
              return { error: "key is required for press" };
            }
            const value = await evaluateInTarget(
              wsUrl,
              `(() => {
                const evInit = { key: ${JSON.stringify(keyValue)}, bubbles: true };
                document.dispatchEvent(new KeyboardEvent("keydown", evInit));
                document.dispatchEvent(new KeyboardEvent("keyup", evInit));
                return { ok: true };
              })()`
            );
            return { sessionId: activeSessionId, targetId: target.id, result: value };
          }

          return { error: `Unsupported action: ${action}` };
        } catch (err) {
          return {
            error: `Browser CDP failed: ${
              err instanceof Error ? err.message : "Unknown error"
            }`,
          };
        }
      },
    }),
  };
};
