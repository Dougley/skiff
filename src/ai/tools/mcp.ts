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

/**
 * Create clients for every configured MCP server. A missing or invalid config
 * and unreachable servers degrade to "no MCP tools" instead of failing the
 * process — MCP is an optional extension, never a startup dependency.
 */
export async function getMCPServers(configPath?: string) {
  let config: MCPConfig;
  try {
    config = await loadMCPConfig(configPath);
  } catch (err) {
    logger.warn("MCP config not loaded — continuing without MCP tools", {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const clients: MCPClient[] = [];
  for (const [name, server] of Object.entries(config.mcpServers)) {
    try {
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
    } catch (err) {
      logger.warn(`MCP server "${name}" failed to connect — skipping`, {
        err: err instanceof Error ? err.message : String(err),
      });
    }
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
      // inter-server collision: first server wins, later ones are dropped
      if (Object.hasOwn(acc, name)) {
        logger.warn(
          `MCP tool name collision: a later server also defines "${name}" — keeping the first, dropping the duplicate`
        );
        continue;
      }
      acc[name] = tool;
    }
    return acc;
  }, {});
  return tools;
}

// resolved once at startup; the inner catches make rejection impossible, but
// guard anyway so a rejected module-level promise can never kill the process
export const mcpConfig: Promise<MCPClient[]> = getMCPServers().catch((err) => {
  logger.error("MCP initialization failed — continuing without MCP tools", {
    err,
  });
  return [];
});

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
