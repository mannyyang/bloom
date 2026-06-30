/**
 * Isolated test file for generateStatsJson verbose nextItemRationale parity.
 *
 * generateStatsJson with verbose=true now includes nextItemRationale, matching
 * the text-mode generateStatsOutput behaviour. The try/catch path that calls
 * readRoadmap/parseRoadmap/pickNextItemWithRationale cannot be covered from
 * stats.test.ts without a top-level vi.mock that would affect 1600+ other tests.
 * This dedicated file keeps mock infrastructure isolated.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initDb, insertCycle } from "../src/db.js";
import { generateStatsJson } from "../src/stats.js";
import { makeOutcome } from "./helpers.js";

vi.mock("../src/planning.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    readRoadmap: vi.fn(),
    parseRoadmap: vi.fn(),
    pickNextItemWithRationale: vi.fn(),
  };
});

import { readRoadmap, parseRoadmap, pickNextItemWithRationale } from "../src/planning.js";
const mockReadRoadmap = vi.mocked(readRoadmap);
const mockParseRoadmap = vi.mocked(parseRoadmap);
const mockPickNextItem = vi.mocked(pickNextItemWithRationale);

describe("generateStatsJson verbose nextItemRationale", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    // Safe defaults: return empty roadmap with no actionable items
    mockReadRoadmap.mockReturnValue("");
    mockParseRoadmap.mockReturnValue([]);
    mockPickNextItem.mockReturnValue({ item: null, rationale: null });
  });

  it("verbose=false omits nextItemRationale from result", () => {
    const result = generateStatsJson(db, undefined, false);
    expect(Object.prototype.hasOwnProperty.call(result, "nextItemRationale")).toBe(false);
  });

  it("verbose=undefined omits nextItemRationale from result", () => {
    const result = generateStatsJson(db);
    expect(Object.prototype.hasOwnProperty.call(result, "nextItemRationale")).toBe(false);
  });

  it("verbose=true includes nextItemRationale field", () => {
    const result = generateStatsJson(db, undefined, true);
    expect(Object.prototype.hasOwnProperty.call(result, "nextItemRationale")).toBe(true);
  });

  it("verbose=true sets nextItemRationale to null when no actionable items exist", () => {
    mockPickNextItem.mockReturnValue({ item: null, rationale: null });
    const result = generateStatsJson(db, undefined, true);
    expect(result.nextItemRationale).toBeNull();
  });

  it("verbose=true sets nextItemRationale to the rationale string when items exist", () => {
    mockPickNextItem.mockReturnValue({
      item: null,
      rationale: "Picked #42 (up-next, 3 reactions): Fix the parser",
    });
    const result = generateStatsJson(db, undefined, true);
    expect(result.nextItemRationale).toBe("Picked #42 (up-next, 3 reactions): Fix the parser");
  });

  it("verbose=true sets nextItemRationale to error string when readRoadmap throws", () => {
    mockReadRoadmap.mockImplementation(() => {
      throw new Error("disk read failed");
    });
    const result = generateStatsJson(db, undefined, true);
    expect(typeof result.nextItemRationale).toBe("string");
    expect(result.nextItemRationale).toContain("unavailable");
    expect(result.nextItemRationale).toContain("disk read failed");
  });

  it("verbose=true result with nextItemRationale is JSON-serialisable", () => {
    mockPickNextItem.mockReturnValue({
      item: null,
      rationale: "Picked #7: Add verbose JSON support",
    });
    const result = generateStatsJson(db, undefined, true);
    expect(() => JSON.stringify(result)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed.nextItemRationale).toBe("Picked #7: Add verbose JSON support");
  });

  it("verbose=true forwards roadmapPath to readRoadmap", () => {
    generateStatsJson(db, undefined, true, undefined, "/custom/ROADMAP.md");
    expect(mockReadRoadmap).toHaveBeenCalledWith("/custom/ROADMAP.md");
  });

  it("verbose=true null nextItemRationale round-trips through JSON as null (not dropped)", () => {
    // undefined is dropped by JSON.stringify but null is preserved.
    // This pin ensures consumers can distinguish "no actionable items" from "field absent".
    mockPickNextItem.mockReturnValue({ item: null, rationale: null });
    const result = generateStatsJson(db, undefined, true);
    const parsed = JSON.parse(JSON.stringify(result));
    expect(Object.prototype.hasOwnProperty.call(parsed, "nextItemRationale")).toBe(true);
    expect(parsed.nextItemRationale).toBeNull();
  });
});
