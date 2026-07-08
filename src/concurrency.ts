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
