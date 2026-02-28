import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { env } from "../env/index.js";

const MAX_OUTPUT_LENGTH = 10_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const SIGTERM_GRACE_MS = 5_000;
const MAX_BUFFER = 1024 * 1024; // 1 MB
const BACKGROUND_AFTER_MS = 5_000; // foreground window before backgrounding

/**
 * Safe environment variables to pass to child processes.
 * Everything else (API keys, tokens, secrets) is stripped.
 */
const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TERM",
  "SHELL",
  "TMPDIR",
  "TZ",
] as const;

/**
 * Patterns that indicate dangerous or abusive commands.
 * Each entry has a regex and a human-readable reason for the block.
 */
const DENIED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Fork bombs
  { pattern: /:\(\)\s*\{.*\|.*&\s*\}/, reason: "Fork bomb detected" },
  // Recursive delete on root
  {
    pattern:
      /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?\/(\s|$|\*)/,
    reason: "Recursive delete on root filesystem",
  },
  {
    pattern:
      /rm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/(\s|$|\*)/,
    reason: "Recursive delete on root filesystem",
  },
  // Disk wiping
  {
    pattern: /dd\s+.*if=\/dev\/(zero|random|urandom).*of=\/dev\//,
    reason: "Disk wipe command detected",
  },
  {
    pattern: /mkfs\.\w+\s+\/dev\//,
    reason: "Filesystem format command detected",
  },
  // Reverse shells
  {
    pattern: /bash\s+-i\s+>&\s*\/dev\/tcp\//,
    reason: "Reverse shell detected",
  },
  {
    pattern: /nc\s+.*-e\s+\/bin\/(sh|bash)/,
    reason: "Reverse shell detected",
  },
  {
    pattern: /python[23]?\s+-c\s+.*socket.*connect/,
    reason: "Reverse shell detected",
  },
  {
    pattern: /perl\s+-e\s+.*socket.*connect/,
    reason: "Reverse shell detected",
  },
  // Crypto miners
  {
    pattern: /\b(xmrig|minerd|cgminer|bfgminer|cpuminer)\b/,
    reason: "Crypto miner detected",
  },
  // Environment snooping (parent process secrets)
  {
    pattern: /\/proc\/self\/environ/,
    reason: "Attempt to read process environment",
  },
  {
    pattern: /\/proc\/\d+\/environ/,
    reason: "Attempt to read process environment",
  },
  {
    pattern: /\bprintenv\b/,
    reason: "Environment enumeration blocked",
  },
  {
    pattern: /\bdeclare\s+-x\b/,
    reason: "Environment enumeration blocked",
  },
  {
    pattern: /(?:^|\s)env(?:\s|$)/,
    reason: "Environment enumeration blocked",
  },
  // Sensitive files
  {
    pattern: /\/etc\/shadow/,
    reason: "Attempt to read sensitive system file",
  },
];

/**
 * Build a sanitized environment object for child processes.
 * Only safe, non-secret variables are included.
 */
function buildSafeEnv(): Record<string, string> {
  const safeEnv: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      safeEnv[key] = value;
    }
  }
  return safeEnv;
}

/**
 * Check if a command matches any denied pattern.
 * Returns the reason string if blocked, or null if allowed.
 */
function checkDenylist(command: string): string | null {
  for (const { pattern, reason } of DENIED_PATTERNS) {
    if (pattern.test(command)) {
      return reason;
    }
  }
  return null;
}

/**
 * Validate that a directory path is within the allowed directories.
 */
function isAllowedDirectory(dir: string): boolean {
  const resolved = path.resolve(env.SHELL_WORK_DIR, dir);
  const workDir = path.resolve(env.SHELL_WORK_DIR);
  const allowedDirs = env.SHELL_ALLOWED_DIRS.split(",")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => path.resolve(d));

  const allAllowed = [workDir, ...allowedDirs];
  return allAllowed.some(
    (allowed) => resolved === allowed || resolved.startsWith(`${allowed}/`)
  );
}

/**
 * Truncate a string to a maximum length, appending a notice if truncated.
 */
function truncate(
  str: string,
  max: number
): { text: string; truncated: boolean } {
  if (str.length <= max) {
    return { text: str, truncated: false };
  }
  return {
    text: `${str.slice(0, max)}\n\n... (output truncated, ${str.length - max} characters omitted)`,
    truncated: true,
  };
}

interface CommandHandle {
  result: Promise<{ exitCode: number; stdout: string; stderr: string }>;
  getBuffers: () => { stdout: string; stderr: string };
}

// start a shell command, killing it only after it's been silent for timeoutMs.
// resets the idle clock on every stdout/stderr chunk, so active processes
// (uploads, long builds) keep running as long as they produce output.
// termination sequence: SIGTERM via AbortSignal → SIGTERM_GRACE_MS grace → SIGKILL
function startCommand(
  command: string,
  cwd: string,
  timeoutMs: number
): CommandHandle {
  const idleController = new AbortController();

  const child = spawn("/bin/sh", ["-c", command], {
    cwd,
    env: buildSafeEnv(),
    signal: idleController.signal,
    killSignal: "SIGTERM",
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  let idleKilled = false;
  let settled = false;

  const result = new Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    const settle = (r: {
      exitCode: number;
      stdout: string;
      stderr: string;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      resolve(r);
    };

    const abortIdle = () => {
      idleKilled = true;
      idleController.abort();
      // escalate to SIGKILL if process doesn't exit after SIGTERM
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited, ignore
        }
      }, SIGTERM_GRACE_MS);
    };

    // reset idle clock whenever the process produces output
    let idleTimer = setTimeout(abortIdle, timeoutMs);
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(abortIdle, timeoutMs);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBuf.length < MAX_BUFFER) stdoutBuf += chunk.toString();
      resetIdle();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBuf.length < MAX_BUFFER) stderrBuf += chunk.toString();
      resetIdle();
    });

    child.on("close", (code) => {
      if (idleKilled) {
        settle({
          exitCode: 137,
          stdout: stdoutBuf,
          stderr: `Command was idle for ${timeoutMs}ms with no output and was terminated.`,
        });
        return;
      }
      settle({ exitCode: code ?? 0, stdout: stdoutBuf, stderr: stderrBuf });
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      // ERR_CHILD_PROCESS_ABORTED fires when our AbortSignal kills the process —
      // the close event will follow and settle the result
      if (err.code === "ERR_CHILD_PROCESS_ABORTED") return;
      settle({
        exitCode: 1,
        stdout: stdoutBuf,
        stderr: stderrBuf || err.message,
      });
    });
  });

  return {
    result,
    getBuffers: () => ({ stdout: stdoutBuf, stderr: stderrBuf }),
  };
}

type Job =
  | { status: "running"; handle: CommandHandle }
  | {
      status: "done" | "terminated";
      exitCode: number;
      stdout: string;
      stderr: string;
    };

export const createShellTools = () => {
  const jobs = new Map<string, Job>();

  return {
    write_file: tool({
      description: "Write content to a file within allowed directories.",
      inputSchema: z.object({
        path: z.string().describe("The absolute path to the file to write."),
        content: z.string().describe("The content to write to the file."),
        partial: z
          .boolean()
          .default(false)
          .describe(
            "Whether this is a partial write (append) or full overwrite."
          ),
        start_offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe(
            "Line number to start writing at (0-indexed). Only used if partial is true."
          ),
        end_offset: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Line number to end writing at (exclusive, 0-indexed). Only used if partial is true. If not provided, writes to the end of the file."
          ),
      }),
      execute: async ({ path, content, partial, start_offset, end_offset }) => {
        if (!isAllowedDirectory(path)) {
          return {
            error: `File path "${path}" is not in the allowed directory list.`,
          };
        }

        try {
          if (partial) {
            const existingContent = await fs
              .readFile(path, "utf-8")
              .catch(() => "");
            const lines = existingContent.split("\n");
            const startLine = Math.max(0, start_offset);
            const endLine =
              end_offset !== undefined
                ? Math.min(end_offset, lines.length)
                : lines.length;
            lines.splice(
              startLine,
              endLine - startLine,
              ...content.split("\n")
            );
            await fs.writeFile(path, lines.join("\n"), "utf-8");
          } else {
            await fs.writeFile(path, content, "utf-8");
          }
          return { success: true };
        } catch (err) {
          return {
            error: `Failed to write file "${path}": ${err instanceof Error ? err.message : "Unknown error"}`,
          };
        }
      },
    }),
    read_file: tool({
      description: "Read the contents of a file within allowed directories.",
      inputSchema: z.object({
        path: z.string().describe("The absolute path to the file to read."),
        start: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Line number to start reading from (0-indexed)."),
        end: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Line number to end reading at (exclusive, 0-indexed). If not provided, reads to the end of the file."
          ),
      }),
      execute: async ({ path, start, end }) => {
        if (!isAllowedDirectory(path)) {
          return {
            error: `File path "${path}" is not in the allowed directory list.`,
          };
        }

        try {
          const content = await fs.readFile(path, "utf-8");
          const lines = content.split("\n");
          const startLine = Math.max(0, start);
          const endLine =
            end !== undefined ? Math.min(end, lines.length) : lines.length;
          const selectedLines = lines.slice(startLine, endLine);
          const truncated = truncate(
            selectedLines.join("\n"),
            MAX_OUTPUT_LENGTH
          );
          return {
            content: truncated.text,
            truncated: truncated.truncated,
          };
        } catch (err) {
          return {
            error: `Failed to read file "${path}": ${err instanceof Error ? err.message : "Unknown error"}`,
          };
        }
      },
    }),
    shell_exec: tool({
      description:
        "Execute a shell command. The command runs in a sandboxed environment with no access to secrets or environment variables. " +
        `The working directory is ${env.SHELL_WORK_DIR}. ` +
        "Use this for file operations, system inspection, running scripts, installing packages, etc. " +
        `Commands that are still running after ${BACKGROUND_AFTER_MS}ms are automatically backgrounded — the tool returns a job ID instead of blocking. Use shell_job_status to poll for the result.`,
      inputSchema: z.object({
        command: z.string().describe("The shell command to execute."),
        timeout: z
          .number()
          .int()
          .min(1000)
          .max(MAX_TIMEOUT_MS)
          .default(DEFAULT_TIMEOUT_MS)
          .describe(
            "Idle timeout in milliseconds — the command is terminated if it produces no stdout/stderr output for this duration (default 30000, max 120000). Resets whenever output is received, so active processes like uploads or builds keep running."
          ),
        cwd: z
          .string()
          .optional()
          .describe(
            `Working directory for the command. Must be within allowed directories. Defaults to ${env.SHELL_WORK_DIR}.`
          ),
      }),
      execute: async ({ command, timeout, cwd }) => {
        const denyReason = checkDenylist(command);
        if (denyReason) {
          return { error: `Command blocked: ${denyReason}` };
        }

        const workDir = cwd ?? env.SHELL_WORK_DIR;
        if (!isAllowedDirectory(workDir)) {
          return {
            error: `Directory "${workDir}" is not in the allowed directory list. Allowed: ${env.SHELL_WORK_DIR}, ${env.SHELL_ALLOWED_DIRS}`,
          };
        }

        const handle = startCommand(command, workDir, timeout);

        // race: either it finishes in the foreground window or we background it
        const backgroundSentinel = Symbol("background");
        const winner = await Promise.race([
          handle.result,
          new Promise<typeof backgroundSentinel>((res) =>
            setTimeout(() => res(backgroundSentinel), BACKGROUND_AFTER_MS)
          ),
        ]);

        if (winner !== backgroundSentinel) {
          // finished within the foreground window — return normally
          const stdout = truncate(winner.stdout, MAX_OUTPUT_LENGTH);
          const stderr = truncate(winner.stderr, MAX_OUTPUT_LENGTH);
          return {
            exitCode: winner.exitCode,
            stdout: stdout.text,
            stderr: stderr.text,
            truncated: stdout.truncated || stderr.truncated,
          };
        }

        // still running — move to background
        const jobId = crypto.randomUUID();
        jobs.set(jobId, { status: "running", handle });

        // update job entry when the process eventually finishes
        void handle.result.then((r) => {
          jobs.set(jobId, {
            status: r.exitCode === 137 ? "terminated" : "done",
            exitCode: r.exitCode,
            stdout: r.stdout,
            stderr: r.stderr,
          });
        });

        return {
          backgrounded: true,
          jobId,
          message: `Command is still running after ${BACKGROUND_AFTER_MS}ms. Use shell_job_status with job ID "${jobId}" to check on it.`,
        };
      },
    }),
    shell_job_status: tool({
      description: "Check the status of a backgrounded shell command.",
      inputSchema: z.object({
        job_id: z.string().describe("The job ID returned by shell_exec."),
      }),
      execute: async ({ job_id }) => {
        const job = jobs.get(job_id);
        if (!job) return { error: "Job not found or already retrieved." };

        if (job.status === "running") {
          const { stdout, stderr } = job.handle.getBuffers();
          return {
            hint: "For long-running commands, consider using the schedule_task tool to check on it later instead of polling with shell_job_status.",
            status: "running",
            stdout: truncate(stdout, MAX_OUTPUT_LENGTH).text,
            stderr: truncate(stderr, MAX_OUTPUT_LENGTH).text,
          };
        }

        // done or terminated — return final result and clean up
        jobs.delete(job_id);
        const stdout = truncate(job.stdout, MAX_OUTPUT_LENGTH);
        const stderr = truncate(job.stderr, MAX_OUTPUT_LENGTH);
        return {
          status: job.status,
          exitCode: job.exitCode,
          stdout: stdout.text,
          stderr: stderr.text,
          truncated: stdout.truncated || stderr.truncated,
        };
      },
    }),
  };
};
