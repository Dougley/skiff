import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

const { env } = await import("../../../src/config/env.js");
const { createWebTools } = await import("../../../src/ai/tools/web.js");

env.BRAVE_SEARCH_API_KEY = "brave-test-key";
env.CLOUDFLARE_ACCOUNT_ID = "acct-1";
env.CLOUDFLARE_API_TOKEN = "cf-token";

const tools = createWebTools();

type ToolLike = {
  inputSchema: { parse: (value: unknown) => unknown };
  execute: (input: unknown, options: unknown) => Promise<unknown>;
};

const EXEC_OPTIONS = { toolCallId: "test-call", messages: [] };

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

const search = (input: unknown) => callTool(tools.web_search, input);
const fetchUrl = (input: unknown) => callTool(tools.fetch_url, input);

type Recorded = {
  url: string;
  init: RequestInit | undefined;
  at: number;
};

const realFetch = globalThis.fetch;

/** Swaps in a routed fetch and returns the list it records calls into. */
function stubFetch(
  handler: (url: URL, init: RequestInit | undefined) => Promise<Response>
): Recorded[] {
  const recorded: Recorded[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    recorded.push({ url, init, at: Date.now() });
    return await handler(new URL(url), init);
  }) as typeof globalThis.fetch;
  return recorded;
}

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });

const headersOf = (call: Recorded | undefined) =>
  (call?.init?.headers ?? {}) as Record<string, string>;

afterEach(() => {
  globalThis.fetch = realFetch;
});

// --- web_search ------------------------------------------------------------

// First test in the file so the rate limiter starts from a clean slate.
test("back-to-back searches are spaced out by the rate limiter", async () => {
  const calls = stubFetch(async () => json({ web: { results: [] } }));

  await Promise.all([search({ query: "a" }), search({ query: "b" })]);

  assert.equal(calls.length, 2);
  const gap = (calls[1]?.at ?? 0) - (calls[0]?.at ?? 0);
  assert.ok(gap >= 990, `expected a ~1s gap between calls, saw ${gap}ms`);
});

test("web_search reports missing configuration instead of calling out", async () => {
  const key = env.BRAVE_SEARCH_API_KEY;
  env.BRAVE_SEARCH_API_KEY = undefined;
  const calls = stubFetch(async () => {
    throw new Error("Brave should not be contacted without a key");
  });

  try {
    const result = await search({ query: "anything" });
    assert.match(String(result.error), /missing BRAVE_SEARCH_API_KEY/);
    assert.equal(calls.length, 0);
  } finally {
    env.BRAVE_SEARCH_API_KEY = key;
  }
});

test("web_search returns title/snippet/url triples from Brave", async () => {
  const calls = stubFetch(async () =>
    json({
      web: {
        results: [
          {
            title: "Cats",
            description: "About cats",
            url: "https://cats.test/",
          },
          { title: "Dogs", url: "https://dogs.test/" },
        ],
      },
    })
  );

  const result = await search({ query: "cats & dogs" });

  assert.deepEqual(result.results, [
    { title: "Cats", snippet: "About cats", url: "https://cats.test/" },
    { title: "Dogs", snippet: undefined, url: "https://dogs.test/" },
  ]);

  const requested = new URL(calls[0]?.url ?? "");
  assert.equal(requested.host, "api.search.brave.com");
  assert.equal(requested.pathname, "/res/v1/web/search");
  assert.equal(requested.searchParams.get("q"), "cats & dogs");
  assert.equal(requested.searchParams.get("count"), "10");
  assert.equal(headersOf(calls[0])["X-Subscription-Token"], "brave-test-key");
  assert.equal(headersOf(calls[0]).Accept, "application/json");
});

test("a search with no web block yields an empty result list", async () => {
  stubFetch(async () => json({ query: { original: "x" } }));

  const result = await search({ query: "obscure" });

  assert.deepEqual(result.results, []);
});

test("a rate-limited search is retried once after the reset window", async () => {
  let attempts = 0;
  const calls = stubFetch(async () => {
    attempts++;
    if (attempts === 1) {
      // compound header: only the first (shortest) window is the real delay
      return new Response("slow down", {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "X-RateLimit-Reset": "0, 2592000" },
      });
    }
    return json({
      web: {
        results: [{ title: "T", description: "D", url: "https://t.test/" }],
      },
    });
  });

  const result = await search({ query: "busy" });

  assert.equal(calls.length, 2);
  assert.deepEqual(result.results, [
    { title: "T", snippet: "D", url: "https://t.test/" },
  ]);
});

test("a failed search surfaces the upstream status text", async () => {
  stubFetch(
    async () =>
      new Response("boom", {
        status: 500,
        statusText: "Internal Server Error",
      })
  );

  const result = await search({ query: "q" });

  assert.equal(result.error, "Brave Search API error: Internal Server Error");
});

// --- fetch_url -------------------------------------------------------------

test("fetch_url refuses non-http schemes", async () => {
  const calls = stubFetch(async () => {
    throw new Error("nothing should be fetched");
  });

  const result = await fetchUrl({ url: "ftp://example.test/file.txt" });

  assert.match(String(result.error), /must start with http:\/\/ or https:\/\//);
  assert.equal(calls.length, 0);
});

test("markdown fetches report missing Cloudflare configuration", async () => {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  env.CLOUDFLARE_ACCOUNT_ID = undefined;
  const calls = stubFetch(async () => {
    throw new Error("Cloudflare should not be contacted");
  });

  try {
    const result = await fetchUrl({ url: "https://example.test/page" });
    assert.match(String(result.error), /missing CLOUDFLARE_ACCOUNT_ID/);
    assert.match(String(result.hint), /format='html'/);
    assert.equal(calls.length, 0);
  } finally {
    env.CLOUDFLARE_ACCOUNT_ID = account;
  }
});

test("markdown is the default format and posts the url to Cloudflare", async () => {
  const calls = stubFetch(async () =>
    json({ success: true, result: "# Heading\n\nbody" })
  );

  const result = await fetchUrl({ url: "https://example.test/page" });

  assert.equal(result.content, "# Heading\n\nbody");
  const call = calls[0];
  assert.equal(
    call?.url,
    "https://api.cloudflare.com/client/v4/accounts/acct-1/browser-rendering/markdown"
  );
  assert.equal(call?.init?.method, "POST");
  assert.equal(headersOf(call).Authorization, "Bearer cf-token");
  assert.equal(headersOf(call)["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(String(call?.init?.body)), {
    url: "https://example.test/page",
  });
});

test("a failed markdown request suggests falling back to html", async () => {
  stubFetch(
    async () => new Response("nope", { status: 502, statusText: "Bad Gateway" })
  );

  const result = await fetchUrl({
    url: "https://example.test/page",
    format: "markdown",
  });

  assert.equal(result.error, "Fetch Markdown error: Bad Gateway");
  assert.match(String(result.hint), /format to 'html'/);
});

test("an unsuccessful markdown payload surfaces Cloudflare's reason", async () => {
  stubFetch(async () =>
    json({ success: false, errors: [{ message: "quota exceeded" }] })
  );

  const result = await fetchUrl({
    url: "https://example.test/page",
    format: "markdown",
  });

  assert.equal(result.error, "Fetch Markdown failed: quota exceeded");
  assert.match(String(result.hint), /format to 'html'/);
});

test("a markdown payload without a reason still reads as a failure", async () => {
  stubFetch(async () => json({ success: true, result: { not: "a string" } }));

  const result = await fetchUrl({
    url: "https://example.test/page",
    format: "markdown",
  });

  assert.equal(result.error, "Fetch Markdown failed: Unknown error");
});

test("a transport failure during a markdown fetch is reported, not thrown", async () => {
  stubFetch(async () => {
    throw new TypeError("fetch failed");
  });

  const result = await fetchUrl({
    url: "https://example.test/page",
    format: "markdown",
  });

  assert.equal(result.error, "Fetch Markdown failed: fetch failed");
  assert.equal(result.hint, undefined);
});

test("html format returns the raw body from a plain fetch", async () => {
  const calls = stubFetch(async () => new Response("<html>hi</html>"));

  const result = await fetchUrl({
    url: "https://example.test/page?x=1",
    format: "html",
  });

  assert.equal(result.content, "<html>hi</html>");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://example.test/page?x=1");
  // the html path fetches the url directly, with no request options
  assert.equal(calls[0]?.init, undefined);
});

test("a failed html fetch surfaces the status text", async () => {
  stubFetch(
    async () =>
      new Response("missing", { status: 404, statusText: "Not Found" })
  );

  const result = await fetchUrl({
    url: "https://example.test/gone",
    format: "html",
  });

  assert.equal(result.error, "Fetch URL error: Not Found");
});

test("a non-Error transport failure during an html fetch is reported", async () => {
  // rejecting with a non-Error is what an odd runtime failure looks like
  stubFetch(() => Promise.reject("socket hang up"));

  const result = await fetchUrl({
    url: "https://example.test/page",
    format: "html",
  });

  assert.equal(result.error, "Fetch URL failed: Unknown error");
});
