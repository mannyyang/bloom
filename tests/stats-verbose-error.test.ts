/**
 * Isolated test file for the generateStatsOutput verbose error path.
 *
 * The try/catch block in generateStatsOutput that renders
 * "Next item selection: unavailable (…)" when readRoadmap() throws cannot be
 * covered from stats.test.ts without introducing a top-level vi.mock that
 * would affect all 1600+ lines of tests in that file.  This dedicated file
 * keeps the mock infrastructure isolated.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initDb, insertCycle } from "../src/db.js";
import { generateStatsOutput, STATS_NEXT_ITEM_HEADER, STATS_NO_ACTIONABLE_ITEMS_MSG } from "../src/stats.js";
import { makeOutcome } from "./helpers.js";

// Mock planning.js so we can control readRoadmap, parseRoadmap, and
// pickNextItemWithRationale in isolation.
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

describe("generateStatsOutput verbose error path", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    // Default: readRoadmap returns empty string (safe — same as file absent)
    mockReadRoadmap.mockReturnValue("");
    mockParseRoadmap.mockReturnValue([]);
    mockPickNextItem.mockReturnValue({ item: null, rationale: null });
  });

  it("renders 'unavailable' message when readRoadmap throws", () => {
    mockReadRoadmap.mockImplementation(() => {
      throw new Error("disk read failed");
    });
    const output = generateStatsOutput(db, undefined, true);
    const joined = output.join("\n");
    expect(joined).toContain(`${STATS_NEXT_ITEM_HEADER} unavailable`);
    expect(joined).toContain("disk read failed");
  });

  it("unavailable message does NOT appear when readRoadmap succeeds", () => {
    mockReadRoadmap.mockReturnValue("");
    const output = generateStatsOutput(db, undefined, true);
    const joined = output.join("\n");
    expect(joined).not.toContain("unavailable");
  });

  it("verbose output still ends with empty string after the error path", () => {
    mockReadRoadmap.mockImplementation(() => {
      throw new Error("timeout");
    });
    const output = generateStatsOutput(db, undefined, true);
    expect(output[output.length - 1]).toBe("");
  });

  it("forwards roadmapPath to readRoadmap when provided", () => {
    // generateStatsOutput accepts a roadmapPath param and forwards it directly
    // to readRoadmap(roadmapPath). Without this assertion, a regression that
    // drops the argument would silently fall back to the default ROADMAP.md path.
    mockReadRoadmap.mockReturnValue("");
    generateStatsOutput(db, undefined, true, undefined, "/custom/path");
    expect(mockReadRoadmap).toHaveBeenCalledWith("/custom/path");
  });

  it("renders rationale string with 2-space indent when pickNextItemWithRationale returns non-null", () => {
    const rationaleText = "Picked #42 (up-next, 3 reactions): Fix the parser";
    mockPickNextItem.mockReturnValue({ item: null, rationale: rationaleText });
    const output = generateStatsOutput(db, undefined, true);
    const joined = output.join("\n");
    expect(joined).toContain(`  ${rationaleText}`);
    expect(joined).toContain(STATS_NEXT_ITEM_HEADER);
  });

  it("renders STATS_NO_ACTIONABLE_ITEMS_MSG with 2-space indent when rationale is null", () => {
    mockPickNextItem.mockReturnValue({ item: null, rationale: null });
    const output = generateStatsOutput(db, undefined, true);
    const joined = output.join("\n");
    expect(joined).toContain(`  ${STATS_NO_ACTIONABLE_ITEMS_MSG}`);
    expect(joined).toContain(STATS_NEXT_ITEM_HEADER);
  });

  it("rationale line appears directly after STATS_NEXT_ITEM_HEADER in the output array", () => {
    const rationaleText = "Picked #7: Add verbose JSON support";
    mockPickNextItem.mockReturnValue({ item: null, rationale: rationaleText });
    const output = generateStatsOutput(db, undefined, true);
    const headerIdx = output.indexOf(STATS_NEXT_ITEM_HEADER);
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(output[headerIdx + 1]).toBe(`  ${rationaleText}`);
  });
});
