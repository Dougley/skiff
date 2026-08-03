import assert from "node:assert/strict";
import { test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

const { AccessAllowlistPrecondition } = await import(
  "../../../src/discord/preconditions/AccessAllowlist.js"
);
const { initAccessConfig } = await import("../../../src/config/access.js");
const { environmentVariableSchema } = await import(
  "../../../src/config/env-schema.js"
);

const BASE_ENV = {
  DISCORD_BOT_TOKEN: `${Buffer.from("123456789012345678").toString("base64")}.test.signature`,
};

/** Re-seed the module-level access config the precondition reads through. */
function configure(overrides: Record<string, string> = {}) {
  initAccessConfig(
    environmentVariableSchema.parse({ ...BASE_ENV, ...overrides })
  );
}

const precondition = new AccessAllowlistPrecondition(
  {
    name: "AccessAllowlist",
    path: "/virtual/preconditions/AccessAllowlist.js",
    root: "/virtual",
    store: { name: "preconditions" },
  } as never,
  {} as never
);

function interaction(
  overrides: {
    guildId?: string | null;
    channelId?: string;
    userId?: string;
  } = {}
) {
  return {
    guildId: "guildId" in overrides ? overrides.guildId : "guild-1",
    channelId: overrides.channelId ?? "channel-1",
    user: { id: overrides.userId ?? "user-1" },
  } as never;
}

/** Sapphire results are Result<unknown, UserError>; unwrap the failure message. */
function denial(result: unknown): string | null {
  const res = result as {
    isOk(): boolean;
    unwrapErr(): { message: string };
  };
  return res.isOk() ? null : res.unwrapErr().message;
}

test("allows a guild interaction under the default open policy", () => {
  configure();

  assert.equal(denial(precondition.chatInputRun(interaction())), null);
});

test("denies a guild interaction when the bot is disabled", () => {
  configure({ ACCESS_POLICY: "disabled" });

  assert.equal(
    denial(precondition.chatInputRun(interaction())),
    "Bot is disabled"
  );
});

test("applies the guild allowlist to chat input commands", () => {
  configure({
    ACCESS_POLICY: "allowlist",
    ACCESS_ALLOWED_GUILDS: "guild-allowed",
  });

  assert.equal(
    denial(precondition.chatInputRun(interaction({ guildId: "guild-1" }))),
    "Guild not in allowlist"
  );
  assert.equal(
    denial(
      precondition.chatInputRun(interaction({ guildId: "guild-allowed" }))
    ),
    null
  );
});

test("routes context menu commands through the same allowlist check", () => {
  configure({
    ACCESS_POLICY: "allowlist",
    ACCESS_ALLOWED_CHANNELS: "channel-ok",
  });

  assert.equal(
    denial(
      precondition.contextMenuRun(interaction({ channelId: "channel-1" }))
    ),
    "Channel not in allowlist"
  );
  assert.equal(
    denial(
      precondition.contextMenuRun(interaction({ channelId: "channel-ok" }))
    ),
    null
  );
});

test("treats a null guildId as a DM and uses the DM policy", () => {
  configure({ ACCESS_DM_POLICY: "disabled" });

  // the same user passes in a guild but is refused in a DM
  assert.equal(denial(precondition.chatInputRun(interaction())), null);
  assert.equal(
    denial(precondition.chatInputRun(interaction({ guildId: null }))),
    "DMs are disabled"
  );
});

test("applies the DM user allowlist", () => {
  configure({
    ACCESS_DM_POLICY: "allowlist",
    ACCESS_ALLOWED_USERS: "user-vip",
  });

  assert.equal(
    denial(
      precondition.chatInputRun(
        interaction({ guildId: null, userId: "user-1" })
      )
    ),
    "User not in DM allowlist"
  );
  assert.equal(
    denial(
      precondition.contextMenuRun(
        interaction({ guildId: null, userId: "user-vip" })
      )
    ),
    null
  );
});
