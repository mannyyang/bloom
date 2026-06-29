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
import { generateStatsOutput, STATS_NEXT_ITEM_HEADER } from "../src/stats.js";
import { makeOutcome } from "./helpers.js";

// Mock planning.js so we can make readRoadmap() throw on demand.
vi.mock("../src/planning.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    readRoadmap: vi.fn(),
  };
});

import { readRoadmap } from "../src/planning.js";
const mockReadRoadmap = vi.mocked(readRoadmap);

describe("generateStatsOutput verbose error path", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    // Default: readRoadmap returns empty string (safe — same as file absent)
    mockReadRoadmap.mockReturnValue("");
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
});
