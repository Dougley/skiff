import assert from "node:assert/strict";
import { test } from "vitest";
import { createLatestUpdateQueue } from "../../src/utils/latest-update-queue.js";

test("reports apply failures to onError and keeps processing later pushes", async () => {
  const applied: string[] = [];
  const errors: unknown[] = [];

  const queue = createLatestUpdateQueue<string>(
    async (value) => {
      if (value === "boom") throw new Error("apply failed");
      applied.push(value);
    },
    (error) => errors.push(error)
  );

  queue.push("boom");
  await queue.flush();
  queue.push("recovered");
  await queue.flush();

  assert.equal(errors.length, 1);
  assert.equal((errors[0] as Error).message, "apply failed");
  assert.deepEqual(applied, ["recovered"]);
});

test("flush resolves immediately when the queue is idle", async () => {
  const queue = createLatestUpdateQueue<number>(
    async () => {},
    () => assert.fail("unexpected error")
  );

  await queue.flush();
});

test("flush waits for an in-flight apply started by push", async () => {
  let resolveApply: (() => void) | undefined;
  let finished = false;

  const queue = createLatestUpdateQueue<string>(
    async () => {
      await new Promise<void>((resolve) => {
        resolveApply = resolve;
      });
      finished = true;
    },
    () => assert.fail("unexpected error")
  );

  queue.push("only");
  const flushed = queue.flush().then(() => {
    assert.equal(finished, true);
  });
  // give push's apply a tick to start before releasing it
  await new Promise((resolve) => setImmediate(resolve));
  resolveApply?.();
  await flushed;
});
