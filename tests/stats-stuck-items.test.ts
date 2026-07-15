/**
 * Isolated test file for the "stuck In Progress items" block emitted by
 * generateStatsOutput when verbose=true.
 *
 * The stuck-items logic calls parseRoadmap (to get items) and then
 * parseInProgressSinceCycle (to read the [since: N] annotation) on items
 * returned by the mock.  We mock readRoadmap and parseRoadmap so tests are
 * fully self-contained and never hit the filesystem.  pickNextItemWithRationale
 * is also mocked to prevent the rationale block from obscuring assertions.
 *
 * This file intentionally mirrors the isolation pattern of stats-json-verbose.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initDb, insertCycle } from "../src/db.js";
import { generateStatsOutput, STATS_STUCK_ITEMS_HEADER, STATS_STUCK_ITEM_AGE_THRESHOLD } from "../src/stats.js";
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

const LATEST_CYCLE = 20;

// Helper to build a minimal ProjectItem-like object for mocking parseRoadmap.
function makeRoadmapItem(title: string, status: string, body: string) {
  return { id: `id-${title}`, title, status, body, linkedIssueNumber: null, reactions: 0 } as ReturnType<typeof parseRoadmap>[number];
}

describe("generateStatsOutput verbose stuck items", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
    // Insert enough cycles so latestCycle == LATEST_CYCLE
    for (let i = 1; i <= LATEST_CYCLE; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
    }
    // Default: empty roadmap, no stuck items, no rationale
    mockReadRoadmap.mockReturnValue("");
    mockParseRoadmap.mockReturnValue([]);
    mockPickNextItem.mockReturnValue({ item: null, rationale: null });
  });

  it("STATS_STUCK_ITEM_AGE_THRESHOLD is a positive integer", () => {
    expect(Number.isInteger(STATS_STUCK_ITEM_AGE_THRESHOLD)).toBe(true);
    expect(STATS_STUCK_ITEM_AGE_THRESHOLD).toBeGreaterThan(0);
  });

  it("STATS_STUCK_ITEMS_HEADER contains the threshold value", () => {
    expect(STATS_STUCK_ITEMS_HEADER).toContain(String(STATS_STUCK_ITEM_AGE_THRESHOLD));
  });

  it("verbose=false: no stuck items block emitted", () => {
    mockParseRoadmap.mockReturnValue([
      makeRoadmapItem("Old item", "In Progress", `[since: ${LATEST_CYCLE - STATS_STUCK_ITEM_AGE_THRESHOLD}]`),
    ]);
    const output = generateStatsOutput(db, undefined, false);
    expect(output.join("\n")).not.toContain(STATS_STUCK_ITEMS_HEADER);
  });

  it("verbose=true: no stuck items block when all In Progress items are recent", () => {
    // age = 1 (below threshold)
    mockParseRoadmap.mockReturnValue([
      makeRoadmapItem("Recent item", "In Progress", `[since: ${LATEST_CYCLE - 1}]`),
    ]);
    const output = generateStatsOutput(db, undefined, true);
    expect(output.join("\n")).not.toContain(STATS_STUCK_ITEMS_HEADER);
  });

  it("verbose=true: no stuck items block when In Progress items have no [since: N] annotation", () => {
    mockParseRoadmap.mockReturnValue([
      makeRoadmapItem("Unannotated item", "In Progress", "No annotation here"),
    ]);
    const output = generateStatsOutput(db, undefined, true);
    expect(output.join("\n")).not.toContain(STATS_STUCK_ITEMS_HEADER);
  });

  it("verbose=true: no stuck items block for non-In Progress items", () => {
    // A Backlog item with [since: 1] should never appear as stuck
    mockParseRoadmap.mockReturnValue([
      makeRoadmapItem("Old backlog", "Backlog", "[since: 1]"),
    ]);
    const output = generateStatsOutput(db, undefined, true);
    expect(output.join("\n")).not.toContain(STATS_STUCK_ITEMS_HEADER);
  });

  it("verbose=true: emits stuck items block when age equals threshold (boundary)", () => {
    const sinceCycle = LATEST_CYCLE - STATS_STUCK_ITEM_AGE_THRESHOLD;
    mockParseRoadmap.mockReturnValue([
      makeRoadmapItem("Boundary stuck item", "In Progress", `[since: ${sinceCycle}]`),
    ]);
    const output = generateStatsOutput(db, undefined, true);
    const joined = output.join("\n");
    expect(joined).toContain(STATS_STUCK_ITEMS_HEADER);
    expect(joined).toContain("Boundary stuck item");
    expect(joined).toContain(`since cycle ${sinceCycle}`);
    expect(joined).toContain(`age: ${STATS_STUCK_ITEM_AGE_THRESHOLD}`);
  });

  it("verbose=true: emits stuck items block when age exceeds threshold", () => {
    const sinceCycle = 1; // age = LATEST_CYCLE - 1 = 19, well above threshold
    mockParseRoadmap.mockReturnValue([
      makeRoadmapItem("Very old item", "In Progress", `[since: ${sinceCycle}]`),
    ]);
    const output = generateStatsOutput(db, undefined, true);
    const joined = output.join("\n");
    expect(joined).toContain(STATS_STUCK_ITEMS_HEADER);
    expect(joined).toContain("Very old item");
    expect(joined).toContain(`since cycle ${sinceCycle}`);
    expect(joined).toContain(`age: ${LATEST_CYCLE - sinceCycle}`);
  });

  it("verbose=true: lists multiple stuck items", () => {
    mockParseRoadmap.mockReturnValue([
      makeRoadmapItem("Item A", "In Progress", "[since: 1]"),
      makeRoadmapItem("Item B", "In Progress", "[since: 2]"),
    ]);
    const output = generateStatsOutput(db, undefined, true);
    const joined = output.join("\n");
    expect(joined).toContain("Item A");
    expect(joined).toContain("Item B");
  });

  it("verbose=true: only stuck items appear in the block (recent items excluded)", () => {
    mockParseRoadmap.mockReturnValue([
      makeRoadmapItem("Stuck item", "In Progress", "[since: 1]"),
      makeRoadmapItem("Recent item", "In Progress", `[since: ${LATEST_CYCLE - 1}]`),
    ]);
    const output = generateStatsOutput(db, undefined, true);
    const joined = output.join("\n");
    expect(joined).toContain(STATS_STUCK_ITEMS_HEADER);
    expect(joined).toContain("Stuck item");
    // "Recent item" should not appear in the stuck block
    // (it appears in the header block for next-item, but not after STATS_STUCK_ITEMS_HEADER)
    const stuckBlockStart = joined.indexOf(STATS_STUCK_ITEMS_HEADER);
    const stuckBlockContent = joined.slice(stuckBlockStart);
    expect(stuckBlockContent).not.toContain("Recent item");
  });
});
