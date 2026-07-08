/**
 * unified-search-one-pass.test.ts — multi-collection unified search.
 *
 * Guards the fix for the per-collection serial loop in structuredSearch
 * (docs/plans/2026-07-08-unified-multi-collection-search.md):
 *
 *  - the collection filter is pushed into SQL (`collection IN (...)`), so a
 *    multi-collection search runs ONE FTS pass per query signal, not one per
 *    collection (regression guard for the N× slowdown + broken RRF weights);
 *  - omitted/empty `collections` searches the whole index;
 *  - global ranking is preserved: a doc's top score is identical whether its
 *    collection is queried alone or as part of a multi-collection set.
 *
 * All cases are LLM-free: lex-only queries with skipRerank, no vectors table.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createStore, structuredSearch, type Store } from "../src/store.js";
import { disposeDefaultLlamaCpp } from "../src/llm.js";

function hashOf(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function collectionOf(filepath: string): string {
  // filepath is `qmd://<collection>/<path>`
  return filepath.split("//")[1]?.split("/")[0] ?? "";
}

describe("unified multi-collection search (structuredSearch, one pass)", () => {
  let testDir: string;
  let store: Store;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "qmd-unified-search-"));
    const testDbPath = join(testDir, "test.sqlite");
    const testConfigDir = await mkdtemp(join(testDir, "config-"));
    process.env.QMD_CONFIG_DIR = testConfigDir;
    store = createStore(testDbPath);

    const now = new Date().toISOString();
    const insert = (collection: string, path: string, title: string, body: string) => {
      const hash = hashOf(body);
      store.insertContent(hash, body, now);
      store.insertDocument(collection, path, title, hash, now, now);
    };

    // Shared term "widget" appears in all three collections. The collection-a
    // doc is by far the strongest BM25 signal (term in title + repeated body),
    // so it must rank #1 globally in every scope that includes it.
    insert("alpha", "widget.md", "Widget Widget Widget",
      "widget widget widget widget widget widget widget widget core reference");
    insert("beta", "notes.md", "Beta notes",
      "a passing mention of widget in beta notes");
    insert("gamma", "log.md", "Gamma log",
      "gamma log with a single widget reference");

    // Collection-only distinct terms for scope tests.
    insert("alpha", "alpha-only.md", "Alpha only", "alphaonlyterm unique to alpha");
    insert("beta", "beta-only.md", "Beta only", "betaonlyterm unique to beta");
    insert("gamma", "gamma-only.md", "Gamma only", "gammaonlyterm unique to gamma");
  });

  afterAll(async () => {
    store.close();
    await disposeDefaultLlamaCpp();
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test("omitted collections searches the whole index (all three collections)", async () => {
    const results = await structuredSearch(store, [{ type: "lex", query: "widget" }], {
      collections: undefined,
      skipRerank: true,
      limit: 20,
    });
    const scopes = new Set(results.map(r => collectionOf(r.file)));
    expect(scopes).toContain("alpha");
    expect(scopes).toContain("beta");
    expect(scopes).toContain("gamma");
  });

  test("empty collections array also searches the whole index", async () => {
    const results = await structuredSearch(store, [{ type: "lex", query: "widget" }], {
      collections: [],
      skipRerank: true,
      limit: 20,
    });
    const scopes = new Set(results.map(r => collectionOf(r.file)));
    expect(scopes).toEqual(new Set(["alpha", "beta", "gamma"]));
  });

  test("explicit collection subset excludes out-of-scope collections (SQL IN filter)", async () => {
    const results = await structuredSearch(store, [{ type: "lex", query: "widget" }], {
      collections: ["alpha", "beta"],
      skipRerank: true,
      limit: 20,
    });
    expect(results.length).toBeGreaterThan(0);
    const scopes = new Set(results.map(r => collectionOf(r.file)));
    expect(scopes).not.toContain("gamma");
    for (const r of results) {
      expect(["alpha", "beta"]).toContain(collectionOf(r.file));
    }
  });

  test("single-collection filter is a degenerate IN and returns only that collection", async () => {
    const results = await structuredSearch(store, [{ type: "lex", query: "widget" }], {
      collections: ["gamma"],
      skipRerank: true,
      limit: 20,
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(collectionOf(r.file)).toBe("gamma");
    }
  });

  test("runs ONE FTS pass per query signal, not one per collection (regression guard)", async () => {
    const original = store.searchFTS;
    let ftsCallCount = 0;
    const seenCollectionArgs: unknown[] = [];
    store.searchFTS = ((query: string, limit?: number, collections?: string | string[]) => {
      ftsCallCount++;
      seenCollectionArgs.push(collections);
      return original(query, limit, collections);
    }) as Store["searchFTS"];

    try {
      await structuredSearch(
        store,
        [
          { type: "lex", query: "widget" },
          { type: "lex", query: "reference" },
        ],
        { collections: ["alpha", "beta", "gamma"], skipRerank: true, limit: 20 },
      );
    } finally {
      store.searchFTS = original;
    }

    // Two lex signals over three collections must be 2 calls (one per signal),
    // NOT 6 (the old per-collection serial loop would have been 2 × 3).
    expect(ftsCallCount).toBe(2);
    // Each call receives the full collection set as an array (pushed into SQL IN).
    for (const arg of seenCollectionArgs) {
      expect(arg).toEqual(["alpha", "beta", "gamma"]);
    }
  });

  test("global ranking: top result score is identical alone vs in a multi-collection set", async () => {
    const alone = await structuredSearch(store, [{ type: "lex", query: "widget" }], {
      collections: ["alpha"],
      skipRerank: true,
      explain: true,
      limit: 20,
    });
    const multi = await structuredSearch(store, [{ type: "lex", query: "widget" }], {
      collections: ["alpha", "beta", "gamma"],
      skipRerank: true,
      explain: true,
      limit: 20,
    });

    const strongestFile = "qmd://alpha/widget.md";
    expect(alone[0]?.file).toBe(strongestFile);
    expect(multi[0]?.file).toBe(strongestFile);

    // The strongest doc ranks #1 in both scopes, so its global RRF score must
    // match — proving ranking is global, not per-collection normalized.
    expect(multi[0]!.score).toBeCloseTo(alone[0]!.score, 10);
    expect(multi[0]!.explain!.rrf.totalScore).toBeCloseTo(alone[0]!.explain!.rrf.totalScore, 10);
  });
});
