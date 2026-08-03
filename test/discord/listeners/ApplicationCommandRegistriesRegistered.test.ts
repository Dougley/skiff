import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";
import { loaderContext } from "./fixtures.js";

bootstrapTestEnv();

// the listener is a thin delegate — persistCommandIds itself is covered by
// test/discord/command-id-hints.test.ts
vi.mock("../../../src/discord/command-id-hints.js", () => ({
  persistCommandIds: vi.fn(async () => {}),
}));

const { CommandIdHintsListener } = await import(
  "../../../src/discord/listeners/ApplicationCommandRegistriesRegistered.js"
);
const { persistCommandIds } = await import(
  "../../../src/discord/command-id-hints.js"
);
const { Events } = await import("@sapphire/framework");

const listener = new CommandIdHintsListener(
  loaderContext("applicationCommandRegistriesRegistered"),
  {}
);

test("listens once for ApplicationCommandRegistriesRegistered", () => {
  assert.equal(listener.event, Events.ApplicationCommandRegistriesRegistered);
  assert.equal(listener.once, true);
});

test("hands the registries to persistCommandIds", async () => {
  const registries = new Map([["ask", { commandName: "ask" }]]);
  await listener.run(registries as never);

  assert.equal(vi.mocked(persistCommandIds).mock.calls.length, 1);
  assert.equal(vi.mocked(persistCommandIds).mock.calls[0]?.[0], registries);
});

test("propagates persistence failures to Sapphire's error handling", async () => {
  vi.mocked(persistCommandIds).mockRejectedValueOnce(new Error("db is gone"));
  await assert.rejects(() => listener.run(new Map() as never), /db is gone/);
});
