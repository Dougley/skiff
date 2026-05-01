#!/usr/bin/env node

import "./discord/logger-bridge.js";

import pkg from "../package.json" with { type: "json" };
import { initAccessConfig } from "./config/access.js";
import { env } from "./config/env.js";
import { colors, logger } from "./config/logger.js";
import { client as pgClient } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { client, startClient } from "./discord/client.js";
import { loadAieosFile } from "./ai/aieos/index.js";
import { setAieos } from "./ai/aieos/state.js";
import { closeMCPClients } from "./ai/tools/mcp.js";
import { initSkills } from "./ai/skills/index.js";
import { startScheduler, stopScheduler } from "./autonomous/scheduler/index.js";
import { startHeartbeat, stopHeartbeat } from "./autonomous/heartbeat/index.js";
import { loadAddendaCache } from "./autonomous/sleep/addenda.js";
import { startSleepCycle, stopSleepCycle } from "./autonomous/sleep/index.js";

function printBanner(metrics: {
  agentName: string;
  agentVersion: string;
  skills: number;
  model: string;
  embeddings: string;
  startupMs: number;
  botTag?: string;
  guilds?: number;
}) {
  const m = metrics;
  const dim = colors.dim;
  const cyan = colors.cyan;
  const bold = colors.bold;

  const lines = [
    `${dim("agent")}     ${bold(m.agentName)} ${dim(`v${m.agentVersion}`)}`,
    `${dim("model")}     ${cyan(m.model)}`,
    `${dim("embed")}     ${cyan(m.embeddings)}`,
    `${dim("skills")}    ${cyan(String(m.skills))} loaded`,
    ...(m.botTag ? [`${dim("bot")}       ${cyan(m.botTag)}`] : []),
    ...(m.guilds !== undefined
      ? [`${dim("guilds")}    ${cyan(String(m.guilds))}`]
      : []),
    `${dim("startup")}   ${colors.green(`${m.startupMs}ms`)}`,
  ];

  // ( ･ω･)つ━☆・*。・゜+.
  console.log(`
  ${colors.yellow("/￣ヽ")}           ${colors.blue("__ _    _  __  __ ")}
${colors.yellow("∠)・ /")} ∧_∧       ${colors.blue("/ _\\ | _(_)/ _|/ _|")}
  ${colors.yellow("/ /")} (-ω- )     ${colors.blue("\\ \\| |/ / | |_| |_ ")}
 ${colors.yellow("(  ￣")}∪∪${colors.yellow("￣")}⩌ ${colors.yellow(" )")}   ${colors.blue("_\\ \\   <| |  _|  _|")}
${colors.bgBlue("~~~~~~~~~~~~~~")}   ${colors.blue("\\__/_|\\_\\_|_| |_|   ")}
${dim(`v${pkg.version}`)}
${dim("─".repeat(40))}
${lines.join("\n")}
${dim("─".repeat(40))}
`);
}

async function main() {
  const startTime = performance.now();

  // Buffer all logs until the banner is printed
  logger.pauseLogs();

  initAccessConfig(env);

  const aieos = await loadAieosFile(env.AIEOS_FILE);
  setAieos(aieos);

  await initSkills(env.SKILLS_DIR);

  await runMigrations();
  await loadAddendaCache();
  await startClient();

  // Wait for the client ready event (guild cache populated)
  const ready = client.isReady()
    ? client
    : await new Promise<typeof client>((resolve) =>
        client.once("clientReady", () => resolve(client))
      );

  const startupMs = Math.round(performance.now() - startTime);

  printBanner({
    agentName: aieos.identity.names.nickname,
    agentVersion: aieos.metadata.instance_version,
    skills: aieos.capabilities.skills.length,
    model: env.LLM_DEFAULT_MODEL,
    embeddings:
      env.EMBEDDING_PROVIDER === "disabled" ? "disabled" : env.EMBEDDING_MODEL,
    startupMs,
    botTag: ready.user?.tag,
    guilds: ready.guilds.cache.size,
  });

  // Flush buffered startup logs after the banner
  logger.resumeLogs();

  // Start both scheduler (for cron tasks) and heartbeat (for periodic checks)
  startScheduler(ready);
  startHeartbeat(ready);
  startSleepCycle();
}

function registerShutdownHandlers() {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down gracefully...`);

    try {
      stopScheduler();
      stopHeartbeat();
      stopSleepCycle();
      await closeMCPClients();
      await pgClient.close().catch((err: unknown) => {
        logger.warn("Failed to close database", { err });
      });
      client.destroy();
    } catch (err) {
      logger.error("Error during shutdown", { err });
    }

    logger.info("Shutdown complete.");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

registerShutdownHandlers();

main().catch((err) => {
  logger.resumeLogs();
  logger.error("Error during startup:", err);
  process.exit(1);
});
