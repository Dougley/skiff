import * as path from "node:path";
import type { MCPClient } from "@ai-sdk/mcp";
import { tool } from "ai";
import { z } from "zod";
import { getSkill, getSkillCatalog } from "../skills/index.js";
import { getMCPServers } from "./mcp.js";

export function createSkillTools(
  pendingSkillTools: Record<string, unknown>,
  openClients: MCPClient[]
) {
  return {
    list_skills: tool({
      description: "List available skills with their names and descriptions",
      inputSchema: z.object({}),
      execute: async () => {
        const catalog = getSkillCatalog();
        if (catalog.length === 0) return "No skills available.";
        return JSON.stringify(catalog);
      },
    }),

    activate_skill: tool({
      description:
        "Activate a skill by name to receive its full instructions. " +
        "Call this when the user's request matches a skill's description.",
      inputSchema: z.object({
        name: z.string().describe("The skill name to activate"),
      }),
      execute: async ({ name }) => {
        const skill = getSkill(name);
        if (!skill) return `Skill "${name}" not found.`;

        const parts = [skill.instructions];

        if (skill.hasMCP) {
          try {
            const configPath = path.join(skill.dir, "mcp.json");
            const clients = await getMCPServers(configPath);
            openClients.push(...clients); // tracked for cleanup after the turn
            const toolSets = await Promise.all(clients.map((c) => c.tools()));
            const toolNames: string[] = [];
            for (const set of toolSets) {
              for (const [toolName, tool] of Object.entries(set)) {
                // store tools for the outer loop to inject into the active toolset
                pendingSkillTools[toolName] = tool;
                toolNames.push(toolName);
              }
            }
            if (toolNames.length > 0) {
              parts.push(
                `\nThis skill provides the following tools: ${toolNames.join(", ")}`
              );
            }
          } catch (err) {
            parts.push(
              `\nFailed to load skill MCP tools: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        return parts.join("\n");
      },
    }),
  };
}
