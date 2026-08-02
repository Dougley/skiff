// Minimal stdio MCP server that reports how many times it has been asked for
// its tool list. The count rides in a tool name because the toolset merge only
// ever reads names — no tool here is executable, and none needs to be.
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const inputSchema = { type: "object", properties: {} };

let listCalls = 0;

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
          serverInfo: { name: "skiff-test-counting", version: "0.0.0" },
        },
      });
    } else if (message.method === "tools/list") {
      listCalls++;
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            { name: "probe", description: "probe", inputSchema },
            {
              name: `list_calls_${listCalls}`,
              description: "how many times this server has been listed",
              inputSchema,
            },
          ],
        },
      });
    } else {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
});
