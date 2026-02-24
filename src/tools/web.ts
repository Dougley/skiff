import { tool } from "ai";
import { z } from "zod";
import { env } from "../env/index.js";

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
        const response = await fetch(
          `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
            query
          )}&count=10`,
          {
            headers: {
              Accept: "application/json",
              "Accept-Encoding": "gzip",
              "X-Subscription-Token": env.BRAVE_SEARCH_API_KEY as string,
            },
          }
        );
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
