import assert from "node:assert/strict";
import {
  type Client,
  ComponentType,
  type Message,
  type MessageEditOptions,
} from "discord.js";
import { test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

const { createUserInputTools } = await import(
  "../../../src/ai/tools/user-input.js"
);

const toolOpts = { toolCallId: "test-call", messages: [] } as never;

type AwaitOptions = {
  componentType: number;
  time: number;
  filter: (interaction: { user: { id: string }; customId: string }) => boolean;
};

interface HarnessOptions {
  /** Value the fake user picks, per question. `null` makes the wait reject. */
  answers: Array<string | null>;
  /** Return null from editStatusMessage to simulate a failed status edit. */
  editReturnsNull?: boolean;
}

/** Records what the tool rendered and hands back scripted selections. */
function harness(opts: HarnessOptions) {
  const edits: MessageEditOptions[] = [];
  const awaitOptions: AwaitOptions[] = [];
  const deferred: number[] = [];
  let call = 0;

  const editStatusMessage = async (options: MessageEditOptions) => {
    edits.push(options);
    if (opts.editReturnsNull) return null;
    const answer = opts.answers[call];
    call++;
    return {
      awaitMessageComponent: async (waitOptions: AwaitOptions) => {
        awaitOptions.push(waitOptions);
        if (answer === null || answer === undefined) {
          throw new Error("Collector received no interactions before ending");
        }
        return {
          values: answer === "" ? [] : [answer],
          deferUpdate: async () => {
            deferred.push(awaitOptions.length - 1);
          },
        };
      },
    } as unknown as Message;
  };

  return { edits, awaitOptions, deferred, editStatusMessage };
}

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    client: {} as Client,
    guildId: "ui-guild",
    channelId: "ui-channel",
    userId: "ui-user",
    ...overrides,
  } as import("../../../src/ai/tools/discord.js").DiscordToolContext;
}

const oneQuestion = {
  questions: [
    {
      question: "Which database?",
      answers: [
        { label: "Postgres", value: "postgres" },
        { label: "SQLite", value: "sqlite" },
      ],
    },
  ],
};

test("ask_questions is unavailable without a status message to edit", async () => {
  const tools = createUserInputTools(ctx());
  assert.deepEqual(
    await tools.ask_questions.execute?.(oneQuestion as never, toolOpts),
    { error: "Interactive questions are not available in this context." }
  );
});

test("ask_questions renders the question as a select menu and returns the pick", async () => {
  const h = harness({ answers: ["postgres"] });
  const tools = createUserInputTools(
    ctx({ editStatusMessage: h.editStatusMessage })
  );

  const result = await tools.ask_questions.execute?.(
    oneQuestion as never,
    toolOpts
  );
  assert.deepEqual(result, {
    responses: [{ question: "Which database?", answer: "postgres" }],
  });

  // one edit, carrying the prompt text and a select menu with both options
  assert.equal(h.edits.length, 1);
  const payload = JSON.parse(JSON.stringify(h.edits[0])) as {
    components: Array<Record<string, unknown>>;
  };
  const rendered = JSON.stringify(payload.components);
  assert.match(rendered, /Which database\?/);
  assert.match(rendered, /Postgres/);
  assert.match(rendered, /sqlite/);

  // the selection was acknowledged so Discord doesn't show "interaction failed"
  assert.deepEqual(h.deferred, [0]);
  assert.equal(h.awaitOptions[0]?.componentType, ComponentType.StringSelect);
  assert.equal(h.awaitOptions[0]?.time, 5 * 60 * 1000);
});

test("multiple questions are asked one after another, each with its own menu", async () => {
  const h = harness({ answers: ["yes", "later"] });
  const tools = createUserInputTools(
    ctx({ editStatusMessage: h.editStatusMessage })
  );

  const result = await tools.ask_questions.execute?.(
    {
      questions: [
        {
          question: "Ship it?",
          answers: [
            { label: "Yes", value: "yes" },
            { label: "No", value: "no" },
          ],
        },
        {
          question: "When?",
          answers: [
            { label: "Now", value: "now" },
            { label: "Later", value: "later" },
          ],
        },
      ],
    } as never,
    toolOpts
  );

  assert.deepEqual(result, {
    responses: [
      { question: "Ship it?", answer: "yes" },
      { question: "When?", answer: "later" },
    ],
  });
  assert.equal(h.edits.length, 2);
});

test("the collector filter accepts only the asking user and this menu", async () => {
  const h = harness({ answers: ["postgres"] });
  const tools = createUserInputTools(
    ctx({ editStatusMessage: h.editStatusMessage })
  );
  await tools.ask_questions.execute?.(oneQuestion as never, toolOpts);

  const options = h.awaitOptions[0];
  assert.ok(options);
  // the custom id the tool minted for this menu, read back off the payload
  const rendered = JSON.parse(JSON.stringify(h.edits[0]));
  const customId = JSON.stringify(rendered).match(/"(ask_q_\d+)"/)?.[1];
  assert.ok(customId, "the menu should carry a generated custom id");

  assert.equal(options.filter({ user: { id: "ui-user" }, customId }), true);
  // a bystander clicking the menu is ignored
  assert.equal(
    options.filter({ user: { id: "someone-else" }, customId }),
    false
  );
  // so is a stale menu from an earlier question
  assert.equal(
    options.filter({ user: { id: "ui-user" }, customId: "ask_q_000" }),
    false
  );
});

test("without a user in context any responder is accepted", async () => {
  const h = harness({ answers: ["postgres"] });
  const tools = createUserInputTools(
    ctx({ userId: null, editStatusMessage: h.editStatusMessage })
  );
  await tools.ask_questions.execute?.(oneQuestion as never, toolOpts);

  const options = h.awaitOptions[0];
  const customId = JSON.stringify(h.edits[0]).match(/(ask_q_\d+)/)?.[1];
  assert.ok(options && customId);
  assert.equal(options.filter({ user: { id: "anybody" }, customId }), true);
});

test("a failed status edit is reported instead of hanging", async () => {
  const h = harness({ answers: [], editReturnsNull: true });
  const tools = createUserInputTools(
    ctx({ editStatusMessage: h.editStatusMessage })
  );
  assert.deepEqual(
    await tools.ask_questions.execute?.(oneQuestion as never, toolOpts),
    {
      responses: [
        { question: "Which database?", answer: "(failed to show question)" },
      ],
    }
  );
});

test("a timed-out menu becomes a no-response answer, not an error", async () => {
  const h = harness({ answers: [null] });
  const tools = createUserInputTools(
    ctx({ editStatusMessage: h.editStatusMessage })
  );
  assert.deepEqual(
    await tools.ask_questions.execute?.(oneQuestion as never, toolOpts),
    {
      responses: [
        { question: "Which database?", answer: "(no response — timed out)" },
      ],
    }
  );
});

test("an interaction carrying no values yields an empty answer", async () => {
  const h = harness({ answers: [""] });
  const tools = createUserInputTools(
    ctx({ editStatusMessage: h.editStatusMessage })
  );
  assert.deepEqual(
    await tools.ask_questions.execute?.(oneQuestion as never, toolOpts),
    { responses: [{ question: "Which database?", answer: "" }] }
  );
});
