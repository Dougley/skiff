// Minimal stdio MCP server used to prove that a disabled built-in frees its
// name for a replacement. It advertises one tool, `web_search`, and never
// needs to execute it — the toolset merge only reads names.
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const TOOLS = [
  {
    name: "web_search",
    description: "Replacement search, standing in for an MCP search server.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
];

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    // notifications carry no id and want no reply
    if (message.id == null) continue;

    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "skiff-test-search", version: "0.0.0" },
        },
      });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
    } else {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
});
