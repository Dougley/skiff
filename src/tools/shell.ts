import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { env } from "../env/index.js";

const MAX_OUTPUT_LENGTH = 10_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;

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
    pattern: /\b(^|\s)env\s*($|\s)/,
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

/**
 * Execute a shell command in a child process.
 */
function executeCommand(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      "/bin/sh",
      ["-c", command],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024, // 1 MB buffer
        env: buildSafeEnv(),
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        if (error && "killed" in error && error.killed) {
          resolve({
            exitCode: 137,
            stdout: stdout ?? "",
            stderr: `Command timed out after ${timeoutMs}ms and was killed.`,
          });
          return;
        }
        resolve({
          exitCode:
            error?.code != null && typeof error.code === "number"
              ? error.code
              : (child.exitCode ?? 0),
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      }
    );
  });
}

export const createShellTools = () => {
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
            lines.splice(startLine, endLine - startLine, ...content.split("\n"));
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
        "Use this for file operations, system inspection, running scripts, installing packages, etc.",
      inputSchema: z.object({
        command: z.string().describe("The shell command to execute."),
        timeout: z
          .number()
          .int()
          .min(1000)
          .max(MAX_TIMEOUT_MS)
          .default(DEFAULT_TIMEOUT_MS)
          .describe(
            "Maximum execution time in milliseconds (default 30000, max 120000)."
          ),
        cwd: z
          .string()
          .optional()
          .describe(
            `Working directory for the command. Must be within allowed directories. Defaults to ${env.SHELL_WORK_DIR}.`
          ),
      }),
      execute: async ({ command, timeout, cwd }) => {
        // Validate command against denylist
        const denyReason = checkDenylist(command);
        if (denyReason) {
          return { error: `Command blocked: ${denyReason}` };
        }

        // Validate and resolve working directory
        const workDir = cwd ?? env.SHELL_WORK_DIR;
        if (!isAllowedDirectory(workDir)) {
          return {
            error: `Directory "${workDir}" is not in the allowed directory list. Allowed: ${env.SHELL_WORK_DIR}, ${env.SHELL_ALLOWED_DIRS}`,
          };
        }

        try {
          const result = await executeCommand(command, workDir, timeout);
          const stdout = truncate(result.stdout, MAX_OUTPUT_LENGTH);
          const stderr = truncate(result.stderr, MAX_OUTPUT_LENGTH);

          return {
            exitCode: result.exitCode,
            stdout: stdout.text,
            stderr: stderr.text,
            truncated: stdout.truncated || stderr.truncated,
          };
        } catch (err) {
          return {
            error: `Execution failed: ${err instanceof Error ? err.message : "Unknown error"}`,
          };
        }
      },
    }),
  };
};
