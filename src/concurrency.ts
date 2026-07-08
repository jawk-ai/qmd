/**
 * concurrency.ts - Bounded concurrency helpers for the embed pipeline
 *
 * Used by store.ts to dispatch multiple embedding batches in parallel against
 * remote embedding APIs with high rate limits, while preserving result order
 * and existing abort semantics.
 */

/** Default embed dispatch concurrency (1 = sequential, today's behavior). */
export const DEFAULT_EMBED_CONCURRENCY = 1;

/** Default number of chunks per embedBatch call (aligned with remote maxBatchSize default). */
export const DEFAULT_EMBED_BATCH_SIZE = 32;

/**
 * Resolve embed dispatch concurrency from QMD_EMBED_CONCURRENCY.
 * Default 1 (sequential — no behavior change unless explicitly configured).
 */
export function resolveEmbedConcurrency(): number {
  return parsePositiveIntEnv("QMD_EMBED_CONCURRENCY", DEFAULT_EMBED_CONCURRENCY);
}

/**
 * Resolve the number of chunks sent per embedBatch call from QMD_REMOTE_BATCH_SIZE.
 * Shared with RemoteLLM's maxBatchSize so that one store-level batch maps to
 * exactly one HTTP request when using a remote backend. Default 32.
 */
export function resolveEmbedBatchSize(): number {
  return parsePositiveIntEnv("QMD_REMOTE_BATCH_SIZE", DEFAULT_EMBED_BATCH_SIZE);
}

function parsePositiveIntEnv(name: string, defaultValue: number): number {
  const val = process.env[name];
  if (!val) return defaultValue;
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

/**
 * Map items through an async function with bounded concurrency.
 *
 * - At most `concurrency` invocations of `fn` are in flight at any time.
 * - Results are returned in input order regardless of completion order.
 * - Items are dispatched in input order.
 * - `beforeDispatch(index)` (if given) runs synchronously before each dispatch;
 *   returning false aborts all remaining (undispatched) items. In-flight items
 *   run to completion. Skipped slots stay undefined in the result array.
 * - If `fn` throws, no further items are dispatched and the error propagates.
 *
 * With concurrency=1 this is exactly a sequential for-await loop.
 */
/**
 * Minimal FIFO async mutex.
 *
 * Serializes access to shared mutable state across concurrent async workers
 * (e.g. the embed pipeline's counters, failure map, and retry queue when
 * QMD_EMBED_CONCURRENCY > 1). JavaScript never preempts synchronous code, but
 * an `await` inside a critical section yields the event loop, letting another
 * worker observe/mutate half-updated shared state or re-process the same
 * retry-queue entry. `runExclusive` guarantees at most one holder runs its
 * callback to completion (including across its internal awaits) before the next
 * waiter starts. With a single worker the lock is always uncontended.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  /**
   * Run `fn` while holding the lock. Waiters are released in FIFO order. The
   * lock is always released, even if `fn` throws (the rejection propagates to
   * the caller).
   */
  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    // Chain onto the current tail so callers acquire the lock in arrival order.
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });

    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  beforeDispatch?: (index: number) => boolean,
): Promise<(R | undefined)[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.floor(concurrency));
  const results: (R | undefined)[] = new Array(items.length);
  let next = 0;
  let aborted = false;

  const worker = async (): Promise<void> => {
    while (!aborted && next < items.length) {
      const index = next;
      if (beforeDispatch && !beforeDispatch(index)) {
        aborted = true;
        return;
      }
      next++;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (err) {
        aborted = true;
        throw err;
      }
    }
  };

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
