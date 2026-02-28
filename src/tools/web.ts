import { tool } from "ai";
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
          try {
            const response = await fetch("https://markdown.new/", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ url, method: "auto" }),
            });
            if (!response.ok) {
              return {
                error: `Fetch Markdown error: ${response.statusText}`,
                hint: "Try fetching as html instead by setting format to 'html'.",
              };
            }
            const data = (await response.json()) as { content: string };
            return { content: data.content };
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
  };
};
