/**
 * Serializes replace-style remote updates and coalesces queued values to the
 * newest one. This prevents a slower, older edit from landing after a newer
 * status or final response.
 */
export function createLatestUpdateQueue<T>(
  apply: (value: T) => Promise<void>,
  onError: (error: unknown) => void
): {
  push: (value: T) => void;
  flush: () => Promise<void>;
} {
  let queuedValue: T | undefined;
  let hasQueuedValue = false;
  let active: Promise<void> | null = null;

  const start = () => {
    if (active || !hasQueuedValue) return;

    active = (async () => {
      while (hasQueuedValue) {
        const value = queuedValue as T;
        queuedValue = undefined;
        hasQueuedValue = false;
        try {
          await apply(value);
        } catch (error) {
          onError(error);
        }
      }
    })().finally(() => {
      active = null;
      start();
    });
  };

  return {
    push(value) {
      queuedValue = value;
      hasQueuedValue = true;
      start();
    },
    async flush() {
      while (hasQueuedValue || active) {
        start();
        const current = active;
        if (current) await current;
      }
    },
  };
}
