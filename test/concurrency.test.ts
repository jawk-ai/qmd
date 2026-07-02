/**
 * Tests for the bounded-concurrency embed dispatch helpers.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  mapWithConcurrency,
  resolveEmbedConcurrency,
  resolveEmbedBatchSize,
  DEFAULT_EMBED_CONCURRENCY,
  DEFAULT_EMBED_BATCH_SIZE,
} from "../src/concurrency.js";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe("mapWithConcurrency", () => {
  it("preserves input order even when completion order differs", async () => {
    // Earlier items take longer, so they complete last
    const items = [50, 30, 10, 5, 1];
    const results = await mapWithConcurrency(items, 5, async (delay, i) => {
      await sleep(delay);
      return `item-${i}`;
    });
    expect(results).toEqual(["item-0", "item-1", "item-2", "item-3", "item-4"]);
  });

  it("never exceeds the concurrency limit", async () => {
    const limit = 3;
    let active = 0;
    let maxActive = 0;

    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), limit, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(5);
      active--;
    });

    expect(maxActive).toBeLessThanOrEqual(limit);
    expect(maxActive).toBeGreaterThan(1); // sanity: actually ran in parallel
  });

  it("runs strictly sequentially with concurrency=1", async () => {
    const events: string[] = [];
    await mapWithConcurrency([0, 1, 2], 1, async (_item, i) => {
      events.push(`start-${i}`);
      await sleep(5);
      events.push(`end-${i}`);
    });
    expect(events).toEqual(["start-0", "end-0", "start-1", "end-1", "start-2", "end-2"]);
  });

  it("dispatches items in input order", async () => {
    const dispatchOrder: number[] = [];
    await mapWithConcurrency([0, 1, 2, 3, 4, 5], 3, async (_item, i) => {
      dispatchOrder.push(i);
      await sleep(Math.random() * 10);
    });
    expect(dispatchOrder).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("stops dispatching when beforeDispatch returns false, leaving undefined slots", async () => {
    let calls = 0;
    const results = await mapWithConcurrency(
      [0, 1, 2, 3, 4],
      1,
      async (item) => {
        calls++;
        return item * 10;
      },
      (index) => index < 2,
    );
    expect(calls).toBe(2);
    expect(results[0]).toBe(0);
    expect(results[1]).toBe(10);
    expect(results[2]).toBeUndefined();
    expect(results[3]).toBeUndefined();
    expect(results[4]).toBeUndefined();
  });

  it("stops dispatching new items after an error and propagates it", async () => {
    let dispatched = 0;
    await expect(
      mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 2, async (item) => {
        dispatched++;
        await sleep(5);
        if (item === 1) throw new Error("boom");
        return item;
      }),
    ).rejects.toThrow("boom");
    // Workers stop pulling new items after the failure; with concurrency 2 at
    // most a couple of extra items were already in flight.
    expect(dispatched).toBeLessThan(10);
  });

  it("handles empty input", async () => {
    const results = await mapWithConcurrency([], 4, async () => 1);
    expect(results).toEqual([]);
  });

  it("clamps concurrency below 1 to sequential", async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency([1, 2, 3], 0, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(2);
      active--;
    });
    expect(maxActive).toBe(1);
  });
});

describe("env resolution", () => {
  afterEach(() => {
    delete process.env.QMD_EMBED_CONCURRENCY;
    delete process.env.QMD_REMOTE_BATCH_SIZE;
  });

  it("defaults to sequential concurrency and batch size 32", () => {
    expect(resolveEmbedConcurrency()).toBe(DEFAULT_EMBED_CONCURRENCY);
    expect(resolveEmbedConcurrency()).toBe(1);
    expect(resolveEmbedBatchSize()).toBe(DEFAULT_EMBED_BATCH_SIZE);
    expect(resolveEmbedBatchSize()).toBe(32);
  });

  it("reads QMD_EMBED_CONCURRENCY", () => {
    process.env.QMD_EMBED_CONCURRENCY = "8";
    expect(resolveEmbedConcurrency()).toBe(8);
  });

  it("reads QMD_REMOTE_BATCH_SIZE above 32 without capping", () => {
    process.env.QMD_REMOTE_BATCH_SIZE = "250";
    expect(resolveEmbedBatchSize()).toBe(250);
  });

  it("falls back to defaults on invalid values", () => {
    process.env.QMD_EMBED_CONCURRENCY = "not-a-number";
    process.env.QMD_REMOTE_BATCH_SIZE = "-5";
    expect(resolveEmbedConcurrency()).toBe(1);
    expect(resolveEmbedBatchSize()).toBe(32);
  });
});
