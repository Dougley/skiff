import { vi } from "vitest";

/**
 * Minimal Sapphire LoaderContext. Piece's constructor only touches
 * name/path/root/store, so a plain object is enough to construct listeners
 * without a running client.
 */
export function loaderContext(name: string) {
  return {
    name,
    path: `/virtual/${name}.ts`,
    root: "/virtual",
    store: {},
  } as never;
}

export interface FakeInteraction {
  user: { id: string };
  channelId: string;
  guildId: string | null;
  deferred: boolean;
  replied: boolean;
  reply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
}

/** A chat-input/context-menu interaction double with recordable replies. */
export function fakeInteraction(
  overrides: Partial<FakeInteraction> = {}
): FakeInteraction {
  return {
    user: { id: "user-1" },
    channelId: "channel-1",
    guildId: "guild-1",
    deferred: false,
    replied: false,
    reply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    ...overrides,
  };
}

/** Swap a logger method for a recorder for the duration of `fn`. */
export async function captureLog<L extends object, K extends keyof L>(
  logger: L,
  method: K,
  fn: () => Promise<unknown> | unknown
) {
  const calls: unknown[][] = [];
  const original = logger[method];
  logger[method] = ((...args: unknown[]) => {
    calls.push(args);
  }) as L[K];
  try {
    await fn();
  } finally {
    logger[method] = original;
  }
  return calls;
}
