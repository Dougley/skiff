import assert from "node:assert/strict";
import type { ClientOptions } from "discord.js";
import { afterEach, test } from "vitest";
import { bootstrapTestEnv } from "../helpers/setup.js";

bootstrapTestEnv();

const sapphire = await import("@sapphire/framework");
const { LogLevel, SapphireClient } = sapphire;
// inference would widen the `unique symbol` to `symbol`, which cannot index
// the plugin class, so the symbol's own type is spelled out
const preGenericsInitialization: typeof import("@sapphire/framework").preGenericsInitialization =
  sapphire.preGenericsInitialization;
const { LoggerBridgePlugin } = await import(
  "../../src/discord/logger-bridge.js"
);
const { logger } = await import("../../src/config/logger.js");

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
type Level = (typeof LEVELS)[number];

const captured: Array<{ level: Level; args: unknown[] }> = [];
const originals = new Map<Level, unknown>();
for (const level of LEVELS) {
  originals.set(level, logger[level]);
  logger[level] = ((...args: unknown[]) => {
    captured.push({ level, args });
  }) as (typeof logger)[Level];
}

afterEach(() => {
  captured.length = 0;
});

/** Run the plugin hook the way SapphireClient does, and hand back the bridge. */
function bridge(options: Partial<ClientOptions> = {}) {
  const clientOptions = options as ClientOptions;
  LoggerBridgePlugin[preGenericsInitialization].call(
    {} as InstanceType<typeof SapphireClient>,
    clientOptions
  );
  const instance = clientOptions.logger?.instance;
  assert.ok(instance, "expected a logger instance to be installed");
  return instance;
}

test("registers itself as a pre-generics initialization hook", () => {
  const hooks = [...SapphireClient.plugins.values()];
  const entry = hooks.find(
    (hook) => hook.name === "Logger-PreGenericsInitialization"
  );
  assert.ok(entry, "logger bridge hook is not registered");
  assert.equal(entry.hook, LoggerBridgePlugin[preGenericsInitialization]);
});

test("installs a logger instance on options that have none", () => {
  const options = {} as ClientOptions;
  bridge(options);
  assert.ok(options.logger);
  assert.equal(typeof options.logger.instance?.info, "function");
});

test("keeps existing logger options and never claims a level is disabled", () => {
  const options = { logger: { level: LogLevel.Debug } } as ClientOptions;
  const instance = bridge(options);
  assert.equal(options.logger?.level, LogLevel.Debug);
  assert.equal(instance.has(LogLevel.Trace), true);
  assert.equal(instance.has(LogLevel.Fatal), true);
});

test("forwards every level to the app logger with all arguments", () => {
  const instance = bridge();
  for (const level of LEVELS) {
    instance[level](`${level} message`, { extra: level });
  }

  assert.deepEqual(
    captured.map((entry) => entry.level),
    [...LEVELS]
  );
  assert.deepEqual(captured[2]?.args, ["info message", { extra: "info" }]);
});

test("routes write() to the matching level", () => {
  const instance = bridge();
  const levels = [
    LogLevel.Trace,
    LogLevel.Debug,
    LogLevel.Info,
    LogLevel.Warn,
    LogLevel.Error,
    LogLevel.Fatal,
  ];
  for (const level of levels) instance.write(level, "written", level);

  assert.deepEqual(
    captured.map((entry) => entry.level),
    [...LEVELS]
  );
  assert.deepEqual(captured[4]?.args, ["written", LogLevel.Error]);
});

test("drops writes for levels it does not map", () => {
  const instance = bridge();
  instance.write(LogLevel.None, "ignored");
  assert.equal(captured.length, 0);
});
