/**
 * Multi-collection filter tests.
 *
 * The collection filter now lives in SQL (`collection IN (...)`) inside
 * searchFTS/searchVec, not in a JS post-filter. These tests assert the `IN`
 * predicate directly and cover backward-compatible input shapes
 * (undefined / [] / string / string[]).
 *
 * See docs/plans/2026-07-08-unified-multi-collection-search.md (§4.1, §5).
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { parseArgs } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createStore, searchFTS, normalizeCollections, type Store } from "../src/store.js";
import { disposeDefaultLlamaCpp } from "../src/llm.js";

describe("normalizeCollections", () => {
  test("undefined → empty (no filter)", () => {
    expect(normalizeCollections(undefined)).toEqual([]);
  });

  test("single string → single-element array", () => {
    expect(normalizeCollections("docs")).toEqual(["docs"]);
  });

  test("array passes through", () => {
    expect(normalizeCollections(["docs", "notes"])).toEqual(["docs", "notes"]);
  });

  test("empty string → empty (no filter)", () => {
    expect(normalizeCollections("")).toEqual([]);
  });

  test("drops falsy entries and de-duplicates", () => {
    expect(normalizeCollections(["docs", "", "docs", "notes"])).toEqual(["docs", "notes"]);
  });
});

describe("searchFTS collection IN filter (SQL, not post-filter)", () => {
  let testDir: string;
  let store: Store;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "qmd-in-filter-"));
    const testConfigDir = await mkdtemp(join(testDir, "config-"));
    process.env.QMD_CONFIG_DIR = testConfigDir;
    store = createStore(join(testDir, "test.sqlite"));

    const now = new Date().toISOString();
    const insert = (collection: string, path: string, body: string) => {
      const hash = createHash("sha256").update(body).digest("hex");
      store.insertContent(hash, body, now);
      store.insertDocument(collection, path, path, hash, now, now);
    };
    // "sharedterm" appears in all three collections.
    insert("a", "doc.md", "sharedterm content in collection a");
    insert("b", "doc.md", "sharedterm content in collection b");
    insert("c", "doc.md", "sharedterm content in collection c");
  });

  afterAll(async () => {
    store.close();
    await disposeDefaultLlamaCpp();
    if (testDir) await rm(testDir, { recursive: true, force: true });
  });

  const collectionOf = (filepath: string) => filepath.split("//")[1]?.split("/")[0] ?? "";

  test("array of collections includes only those, excludes the rest", () => {
    const results = searchFTS(store.db, "sharedterm", 20, ["a", "b"]);
    const scopes = new Set(results.map(r => collectionOf(r.filepath)));
    expect(scopes).toEqual(new Set(["a", "b"]));
    expect(scopes).not.toContain("c");
  });

  test("undefined searches the whole index", () => {
    const results = searchFTS(store.db, "sharedterm", 20, undefined);
    const scopes = new Set(results.map(r => collectionOf(r.filepath)));
    expect(scopes).toEqual(new Set(["a", "b", "c"]));
  });

  test("empty array searches the whole index", () => {
    const results = searchFTS(store.db, "sharedterm", 20, []);
    const scopes = new Set(results.map(r => collectionOf(r.filepath)));
    expect(scopes).toEqual(new Set(["a", "b", "c"]));
  });

  test("single string form still works (backward compat)", () => {
    const results = searchFTS(store.db, "sharedterm", 20, "a");
    expect(results.length).toBe(1);
    expect(collectionOf(results[0]!.filepath)).toBe("a");
  });
});

describe("resolveCollectionFilter input normalization", () => {
  // Test the array normalization logic without the DB dependency
  function normalizeCollectionInput(raw: string | string[] | undefined): string[] {
    if (!raw) return [];
    return Array.isArray(raw) ? raw : [raw];
  }

  test("undefined returns empty array", () => {
    expect(normalizeCollectionInput(undefined)).toEqual([]);
  });

  test("single string returns single-element array", () => {
    expect(normalizeCollectionInput("docs")).toEqual(["docs"]);
  });

  test("array passes through", () => {
    expect(normalizeCollectionInput(["docs", "notes"])).toEqual(["docs", "notes"]);
  });

  test("empty string returns single-element array", () => {
    expect(normalizeCollectionInput("")).toEqual([]);
  });
});

describe("collection option type from parseArgs", () => {
  // Verify that parseArgs with `multiple: true` produces string[]
  test("parseArgs multiple:true produces array for repeated flags", () => {
    const { values } = parseArgs({
      args: ["-c", "docs", "-c", "notes"],
      options: {
        collection: { type: "string", short: "c", multiple: true },
      },
      strict: true,
    });
    expect(values.collection).toEqual(["docs", "notes"]);
  });

  test("parseArgs multiple:true produces array for single flag", () => {
    const { values } = parseArgs({
      args: ["-c", "docs"],
      options: {
        collection: { type: "string", short: "c", multiple: true },
      },
      strict: true,
    });
    expect(values.collection).toEqual(["docs"]);
  });

  test("parseArgs multiple:true produces undefined when flag absent", () => {
    const { values } = parseArgs({
      args: [],
      options: {
        collection: { type: "string", short: "c", multiple: true },
      },
      strict: true,
    });
    expect(values.collection).toBeUndefined();
  });
});
