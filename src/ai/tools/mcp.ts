import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { MCPClient } from "@ai-sdk/mcp";
import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport as StdioClientTransport } from "@ai-sdk/mcp/mcp-stdio";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

interface MCPServerHTTP {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

interface MCPServerSSE {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
}

interface MCPServerStdio {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

type MCPServerConfig = MCPServerHTTP | MCPServerSSE | MCPServerStdio;

interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

const ENV_VAR_PATTERN = /\$\{(\w+)\}/g;

function resolveEnvVars(value: string): string {
  return value.replace(ENV_VAR_PATTERN, (_, key: string) => {
    const resolved = process.env[key];
    if (resolved === undefined) {
      throw new Error(
        `MCP config references environment variable \${${key}} which is not set`
      );
    }
    return resolved;
  });
}

function resolveEnvVarsInConfig(config: MCPConfig): void {
  for (const server of Object.values(config.mcpServers)) {
    if ((server.type === "http" || server.type === "sse") && server.headers) {
      for (const [key, val] of Object.entries(server.headers)) {
        server.headers[key] = resolveEnvVars(val);
      }
    }
    if (server.type === "stdio" && server.env) {
      for (const [key, val] of Object.entries(server.env)) {
        server.env[key] = resolveEnvVars(val);
      }
    }
  }
}

export async function loadMCPConfig(configPath?: string): Promise<MCPConfig> {
  const configLocation = configPath ?? env.MCP_CONFIG_PATH;
  const filePath = configLocation.startsWith("file://")
    ? fileURLToPath(configLocation)
    : path.resolve(configLocation);
  const rawConfig = await fs.readFile(filePath, "utf-8").catch((err) => {
    throw new Error(
      `Failed to read MCP config from ${filePath}: ${err.message}`
    );
  });
  const config = JSON.parse(rawConfig) as MCPConfig;
  // basic validation
  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    throw new Error("Invalid MCP config: missing or invalid mcpServers");
  }
  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (!server.type || !["http", "sse", "stdio"].includes(server.type)) {
      throw new Error(
        `Invalid MCP server config for ${name}: missing or invalid type`
      );
    }
    if ((server.type === "http" || server.type === "sse") && !server.url) {
      throw new Error(`Invalid MCP server config for ${name}: missing url`);
    }
    if (server.type === "stdio" && !server.command) {
      throw new Error(`Invalid MCP server config for ${name}: missing command`);
    }
  }
  resolveEnvVarsInConfig(config);
  return config;
}

const rootMCPClients: MCPClient[] = [];

export async function getMCPServers(configPath?: string) {
  const config = await loadMCPConfig(configPath);
  const serverConfig = config.mcpServers;
  if (!serverConfig) {
    throw new Error("No MCP servers defined in config");
  }

  const clients = [];
  for (const server of Object.values(serverConfig)) {
    switch (server.type) {
      case "http":
        clients.push(
          await createMCPClient({
            transport: {
              type: "http",
              url: server.url,
              headers: server.headers,
            },
          })
        );
        break;
      case "sse":
        clients.push(
          await createMCPClient({
            transport: {
              type: "sse",
              url: server.url,
              headers: server.headers,
            },
          })
        );
        break;
      case "stdio":
        clients.push(
          await createMCPClient({
            transport: new StdioClientTransport({
              command: server.command,
              args: server.args,
              env: server.env,
            }),
          })
        );
        break;
    }
  }

  if (clients.length === 0) {
    throw new Error("No MCP servers created from config");
  }

  if (!configPath) {
    rootMCPClients.push(...clients);
  }

  return clients;
}

export async function createToolset() {
  const mcpClients = await mcpConfig;
  const toolSets = await Promise.all(
    mcpClients.map((client) => client.tools())
  );
  const tools = toolSets.reduce<Record<string, unknown>>((acc, set) => {
    for (const [name, tool] of Object.entries(set)) {
      if (Object.hasOwn(acc, name)) {
        throw new Error(
          `MCP tool name collision detected: multiple servers define a tool named "${name}". ` +
            "Please ensure tool names are unique across MCP servers or implement a conflict resolution strategy."
        );
      }
      acc[name] = tool;
    }
    return acc;
  }, {});
  return tools;
}

export const mcpConfig = getMCPServers();

export async function closeMCPClients(): Promise<void> {
  await Promise.allSettled(
    rootMCPClients.map((c) =>
      c.close().catch((err: unknown) => {
        logger.warn("Failed to close MCP client", { err });
      })
    )
  );
  rootMCPClients.length = 0;
}
