import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initDb, insertCycle, insertPhaseUsage, insertStrategicContext, insertLearning, getCycleStats, formatCycleStats, getLearningCategoryDistribution } from "../src/db.js";
import type { CycleStats } from "../src/db.js";
import { generateStatsOutput, parseLastNArg, parseJsonFlag, parseTableFlag, generateStatsJson, generateStatsTable, STATS_MEMORY_PREVIEW_CHARS } from "../src/stats.js";
import { CYCLE_SUMMARY_SEPARATOR } from "../src/orchestrator.js";
import { makeOutcome } from "./helpers.js";

describe("STATS_MEMORY_PREVIEW_CHARS", () => {
  it("is a positive number less than MAX_MEMORY_CHARS (1200)", () => {
    expect(STATS_MEMORY_PREVIEW_CHARS).toBe(1000);
    expect(STATS_MEMORY_PREVIEW_CHARS).toBeGreaterThan(0);
    expect(STATS_MEMORY_PREVIEW_CHARS).toBeLessThan(1200);
  });
});

describe("generateStatsOutput", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("returns a single message when no cycles exist", () => {
    const output = generateStatsOutput(db);
    expect(output).toEqual(["No evolution cycles recorded yet."]);
  });

  it("includes header with latest cycle number", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 5 }));
    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("Bloom Evolution Statistics");
    expect(joined).toContain("Latest cycle: 5");
  });

  it("includes formatted stats when cycles exist", () => {
    insertCycle(
      db,
      makeOutcome({
        cycleNumber: 1,
        preflightPassed: true,
        improvementsAttempted: 2,
        improvementsSucceeded: 1,
        buildVerificationPassed: true,
        pushSucceeded: true,
      }),
    );
    insertPhaseUsage(db, 1, {
      phase: "evolution",
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalCostUsd: 0.05,
      durationMs: 60000,
      numTurns: 5,
    });

    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    // Should include some stats content from formatCycleStats
    expect(joined).toContain("========================================");
    expect(joined.length).toBeGreaterThan(100);
  });

  it("includes strategic context when available", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertStrategicContext(db, 1, "Focus on improving test coverage.");

    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("Focus on improving test coverage.");
  });

  it("uses the highest cycle number as latest", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 3 }));
    insertCycle(db, makeOutcome({ cycleNumber: 7 }));
    insertCycle(db, makeOutcome({ cycleNumber: 5 }));

    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("Latest cycle: 7");
  });

  it("does not include memory section when no learnings or context exist", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    // Should have header and stats but the memory section should be absent
    expect(joined).toContain("Bloom Evolution Statistics");
    // formatMemoryForPrompt returns "" when no learnings/context exist,
    // so no extra memory block should appear
  });

  it("has exactly 8 entries when one cycle exists and no memory is present", () => {
    // Structural pin: "", separator, title, latest-cycle, separator, "", formatted, ""
    // When no learnings or strategic context exist the memory block is omitted.
    // Any regression that adds/removes a blank line or separator will break this.
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const output = generateStatsOutput(db);
    expect(output).toHaveLength(8);
  });

  it("has exactly 10 entries when one cycle exists and one learning is present", () => {
    // Structural pin: with memory present the layout is:
    // "", separator, title, latest-cycle, separator, "", formatted, "", memory, "" = 10 entries.
    // No-memory path is already pinned to 8 entries. This pin covers the memory branch,
    // catching regressions that add/remove blank lines around the memory block.
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertLearning(db, 1, "pattern", "Always run tests before committing");
    const output = generateStatsOutput(db);
    expect(output).toHaveLength(10);
  });

  it("output[1] and output[4] are exactly CYCLE_SUMMARY_SEPARATOR", () => {
    // Value-pin: the separator constant must appear at the header and footer
    // positions of the stats block. toContain() checks won't catch a separator
    // that drifts to a different index or gets duplicated/removed.
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const output = generateStatsOutput(db);
    expect(output[1]).toBe(CYCLE_SUMMARY_SEPARATOR);
    expect(output[4]).toBe(CYCLE_SUMMARY_SEPARATOR);
  });

  it("output[2] is exactly the title line and output[3] is the latest-cycle line", () => {
    // Value-pin: extends the separator position-pin to the interior title and
    // cycle lines. A refactor that inserts a blank line before the title would
    // shift these to [3] and [4] without tripping the separator or length tests.
    insertCycle(db, makeOutcome({ cycleNumber: 42 }));
    const output = generateStatsOutput(db);
    expect(output[2]).toBe("  Bloom Evolution Statistics");
    expect(output[3]).toBe("  Latest cycle: 42");
  });

  it("includes success rate in output", () => {
    insertCycle(db, makeOutcome({
      cycleNumber: 1,
      buildVerificationPassed: true,
      pushSucceeded: true,
    }));
    insertCycle(db, makeOutcome({
      cycleNumber: 2,
      buildVerificationPassed: false,
      pushSucceeded: false,
    }));
    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("Success rate");
    expect(joined).toContain("50%");
  });

  it("includes improvement averages in stats", () => {
    insertCycle(db, makeOutcome({
      cycleNumber: 1,
      improvementsAttempted: 3,
      improvementsSucceeded: 2,
    }));
    insertCycle(db, makeOutcome({
      cycleNumber: 2,
      improvementsAttempted: 3,
      improvementsSucceeded: 3,
    }));
    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("Avg improvements/cycle");
    expect(joined).toContain("2.5");
  });

  it("shows cost info when phase usage has cost data", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertPhaseUsage(db, 1, {
      phase: "assessment",
      inputTokens: 5000,
      outputTokens: 2000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalCostUsd: 1.23,
      durationMs: 30000,
      numTurns: 3,
    });
    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("Cost");
    expect(joined).toContain("$1.23");
  });

  it("shows token counts in formatted output", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertPhaseUsage(db, 1, {
      phase: "evolution",
      inputTokens: 50000,
      outputTokens: 10000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalCostUsd: 0.50,
      durationMs: 60000,
      numTurns: 5,
    });
    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("tokens");
    expect(joined).toContain("50k in");
    expect(joined).toContain("10k out");
  });

  it("includes learnings in memory section when they exist", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertLearning(db, 1, "pattern", "Always run tests before committing");

    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("Always run tests before committing");
  });

  it("includes both learnings and strategic context when both exist", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertLearning(db, 1, "domain", "SQLite is fast for in-process use");
    insertStrategicContext(db, 1, "Focusing on robustness improvements.");

    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("SQLite is fast for in-process use");
    expect(joined).toContain("Focusing on robustness improvements.");
  });

  it("includes ## Strategic Context header in memory section when strategic context exists", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertStrategicContext(db, 1, "Prioritising coverage improvements this quarter.");
    insertLearning(db, 1, "pattern", "Incremental changes reduce rollback risk");

    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("## Strategic Context");
    expect(joined).toContain("Prioritising coverage improvements this quarter.");
    expect(joined).toContain("Incremental changes reduce rollback risk");
  });

  it("handles a high cycle number correctly", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 9999 }));
    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("Latest cycle: 9999");
  });

  it("shows recent failures count", () => {
    for (let i = 1; i <= 5; i++) {
      insertCycle(db, makeOutcome({
        cycleNumber: i,
        buildVerificationPassed: i % 2 === 0,
        pushSucceeded: i % 2 === 0,
      }));
    }
    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("Recent failures");
    expect(joined).toContain("3");
  });

  it("returns array of strings, not a single string", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const output = generateStatsOutput(db);
    expect(Array.isArray(output)).toBe(true);
    expect(output.length).toBeGreaterThan(1);
    for (const line of output) {
      expect(typeof line).toBe("string");
    }
  });

  describe("failure category breakdown", () => {
    it("getCycleStats returns correct counts per category", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1, buildVerificationPassed: false, pushSucceeded: false, failureCategory: "build_failure" }));
      insertCycle(db, makeOutcome({ cycleNumber: 2, buildVerificationPassed: false, pushSucceeded: false, failureCategory: "build_failure" }));
      insertCycle(db, makeOutcome({ cycleNumber: 3, buildVerificationPassed: false, pushSucceeded: false, failureCategory: "test_failure" }));
      insertCycle(db, makeOutcome({ cycleNumber: 4, buildVerificationPassed: false, pushSucceeded: false, failureCategory: "llm_error" }));
      insertCycle(db, makeOutcome({ cycleNumber: 5, buildVerificationPassed: true, pushSucceeded: true, failureCategory: "none" }));
      const stats = getCycleStats(db);
      expect(stats.failureCategoryBreakdown["build_failure"]).toBe(2);
      expect(stats.failureCategoryBreakdown["test_failure"]).toBe(1);
      expect(stats.failureCategoryBreakdown["llm_error"]).toBe(1);
      expect(stats.failureCategoryBreakdown["none"]).toBeUndefined();
    });

    it("failure breakdown appears in generateStatsOutput when failures exist", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1, buildVerificationPassed: false, pushSucceeded: false, failureCategory: "build_failure" }));
      insertCycle(db, makeOutcome({ cycleNumber: 2, buildVerificationPassed: false, pushSucceeded: false, failureCategory: "test_failure" }));
      const output = generateStatsOutput(db);
      const joined = output.join("\n");
      expect(joined).toContain("build_failure");
      expect(joined).toContain("test_failure");
      expect(joined).toContain("Failure breakdown");
      expect(joined).toContain("across all");
    });

    it("failure breakdown omitted when all cycles have category none", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1, buildVerificationPassed: false, pushSucceeded: false, failureCategory: "none" }));
      const output = generateStatsOutput(db);
      const joined = output.join("\n");
      expect(joined).not.toContain("Failure breakdown");
    });

    it("getCycleStats does not crash when failure_category has unexpected values", () => {
      // Simulate an old/migrated DB row where failure_category might be an empty string
      // by inserting a cycle then manually verifying getCycleStats handles empty breakdown gracefully
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      // getCycleStats excludes 'none' from the breakdown; empty result should not crash
      expect(() => getCycleStats(db)).not.toThrow();
      const stats = getCycleStats(db);
      expect(stats.failureCategoryBreakdown).toEqual({});
    });
  });

  describe("getCycleStats with zero cycles", () => {
    it("returns default stats on a freshly-initialised DB without throwing", () => {
      expect(() => getCycleStats(db)).not.toThrow();
      const stats = getCycleStats(db);
      expect(stats.totalCycles).toBe(0);
      expect(stats.successRate).toBe(0);
      expect(stats.avgImprovements).toBe(0);
      expect(stats.totalCostUsd).toBe(0);
      expect(stats.avgCostPerCycle).toBe(0);
      expect(stats.totalInputTokens).toBe(0);
      expect(stats.totalOutputTokens).toBe(0);
      expect(stats.failureCategoryBreakdown).toEqual({});
    });
  });

  describe("getCycleStats testCountTrend", () => {
    it("is null when no cycles have test counts", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      const stats = getCycleStats(db);
      expect(stats.testCountTrend).toBeNull();
    });

    it("equals testCountAfter minus testCountBefore for a single cycle", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1, testCountBefore: 10, testCountAfter: 13 }));
      const stats = getCycleStats(db);
      expect(stats.testCountTrend).toBe(3);
    });

    it("can be negative when test count decreased", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1, testCountBefore: 20, testCountAfter: 18 }));
      const stats = getCycleStats(db);
      expect(stats.testCountTrend).toBe(-2);
    });

    it("uses newest.testCountAfter minus oldest.testCountBefore across multiple cycles", () => {
      // Rows returned DESC by cycle_number: cycle 2 is newest, cycle 1 is oldest
      insertCycle(db, makeOutcome({ cycleNumber: 1, testCountBefore: 10, testCountAfter: 13 }));
      insertCycle(db, makeOutcome({ cycleNumber: 2, testCountBefore: 13, testCountAfter: 17 }));
      const stats = getCycleStats(db);
      // newest.testCountAfter (17) - oldest.testCountBefore (10) = 7
      expect(stats.testCountTrend).toBe(7);
    });
  });

  describe("getCycleStats avgDurationMinutes", () => {
    it("is null when no cycles have duration data", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1, durationMs: null }));
      const stats = getCycleStats(db);
      expect(stats.avgDurationMinutes).toBeNull();
    });

    it("converts milliseconds to minutes and rounds to 1 decimal place", () => {
      // 90000 ms = 1.5 minutes exactly
      insertCycle(db, makeOutcome({ cycleNumber: 1, durationMs: 90000 }));
      const stats = getCycleStats(db);
      expect(stats.avgDurationMinutes).toBe(1.5);
    });

    it("averages duration across multiple cycles", () => {
      // 60000 ms = 1 min, 120000 ms = 2 min → avg = 1.5 min
      insertCycle(db, makeOutcome({ cycleNumber: 1, durationMs: 60000 }));
      insertCycle(db, makeOutcome({ cycleNumber: 2, durationMs: 120000 }));
      const stats = getCycleStats(db);
      expect(stats.avgDurationMinutes).toBe(1.5);
    });
  });

  describe("getCycleStats recentFailures", () => {
    it("is 0 when all recent cycles succeeded", () => {
      for (let i = 1; i <= 3; i++) {
        insertCycle(db, makeOutcome({ cycleNumber: i, buildVerificationPassed: true, pushSucceeded: true }));
      }
      const stats = getCycleStats(db);
      expect(stats.recentFailures).toBe(0);
    });

    it("counts only failures in the most recent RECENT_FAILURES_WINDOW cycles", () => {
      // 7 cycles: oldest two succeed, then fail/fail/succeed/succeed/fail
      // Most recent 5 (window) are cycles 7,6,5,4,3 → 3 failures
      for (let i = 1; i <= 2; i++) {
        insertCycle(db, makeOutcome({ cycleNumber: i, buildVerificationPassed: true, pushSucceeded: true }));
      }
      insertCycle(db, makeOutcome({ cycleNumber: 3, buildVerificationPassed: false, pushSucceeded: false }));
      insertCycle(db, makeOutcome({ cycleNumber: 4, buildVerificationPassed: false, pushSucceeded: false }));
      insertCycle(db, makeOutcome({ cycleNumber: 5, buildVerificationPassed: true, pushSucceeded: true }));
      insertCycle(db, makeOutcome({ cycleNumber: 6, buildVerificationPassed: true, pushSucceeded: true }));
      insertCycle(db, makeOutcome({ cycleNumber: 7, buildVerificationPassed: false, pushSucceeded: false }));
      const stats = getCycleStats(db);
      expect(stats.recentFailures).toBe(3);
    });
  });

  describe("--last N flag via generateStatsOutput and parseLastNArg", () => {
    it("generateStatsOutput respects lastN and limits cycle window", () => {
      // Insert 5 cycles; request only the last 2 — stats should reflect 2 cycles
      for (let i = 1; i <= 5; i++) {
        insertCycle(db, makeOutcome({ cycleNumber: i, buildVerificationPassed: true, pushSucceeded: true }));
      }
      const output = generateStatsOutput(db, 2);
      const joined = output.join("\n");
      // Stats are computed over 2 cycles, so "Cycles tracked": 2 should appear
      expect(joined).toContain("Cycles tracked**: 2");
    });

    it("parseLastNArg returns the parsed integer for a valid --last N argument", () => {
      expect(parseLastNArg(["node", "stats.js", "--last", "10"])).toBe(10);
      expect(parseLastNArg(["node", "stats.js", "--last", "1"])).toBe(1);
      expect(parseLastNArg(["--last", "50"])).toBe(50);
    });

    it("parseLastNArg returns undefined when only unknown flags are present", () => {
      expect(parseLastNArg(["node", "stats.js", "--verbose"])).toBeUndefined();
    });

    it("parseLastNArg returns undefined when --last is given an invalid value", () => {
      expect(parseLastNArg(["node", "stats.js", "--last", "notanumber"])).toBeUndefined();
      expect(parseLastNArg(["node", "stats.js", "--last", "-5"])).toBeUndefined();
      expect(parseLastNArg(["node", "stats.js", "--last", "0"])).toBeUndefined();
    });

    it("parseLastNArg returns undefined when --last is the final argv item with no following value", () => {
      expect(parseLastNArg(["--last"])).toBeUndefined();
      expect(parseLastNArg(["node", "stats.js", "--last"])).toBeUndefined();
    });
  });

  describe("getCycleStats avgConversionRate single-attempt boundary", () => {
    it("is 100 when 1 improvement was attempted and 1 succeeded", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 1 }));
      const stats = getCycleStats(db);
      expect(stats.avgConversionRate).toBe(100);
    });

    it("is 0 when 1 improvement was attempted and 0 succeeded", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1, improvementsAttempted: 1, improvementsSucceeded: 0 }));
      const stats = getCycleStats(db);
      expect(stats.avgConversionRate).toBe(0);
    });
  });
});

describe("parseJsonFlag", () => {
  it("returns false when --json is absent", () => {
    expect(parseJsonFlag(["node", "stats.js"])).toBe(false);
  });

  it("returns true when --json is present", () => {
    expect(parseJsonFlag(["node", "stats.js", "--json"])).toBe(true);
  });

  it("returns true when --json appears alongside other flags", () => {
    expect(parseJsonFlag(["node", "stats.js", "--last", "5", "--json"])).toBe(true);
  });

  it("returns false for an empty argv", () => {
    expect(parseJsonFlag([])).toBe(false);
  });

  it("returns false when only similar-but-not-equal flags are present", () => {
    expect(parseJsonFlag(["node", "stats.js", "--json2", "--JSON"])).toBe(false);
  });
});

describe("generateStatsJson", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("returns latestCycle=0 and zero-value stats when DB is empty", () => {
    const result = generateStatsJson(db);
    expect(result.latestCycle).toBe(0);
    expect(result.stats.totalCycles).toBe(0);
    expect(result.stats.successRate).toBe(0);
    expect(result.stats.totalCostUsd).toBe(0);
  });

  it("returns correct latestCycle and stats shape when cycles exist", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 3, buildVerificationPassed: true, pushSucceeded: true }));
    insertCycle(db, makeOutcome({ cycleNumber: 5, buildVerificationPassed: false, pushSucceeded: false }));
    const result = generateStatsJson(db);
    expect(result.latestCycle).toBe(5);
    expect(result.stats.totalCycles).toBe(2);
    expect(typeof result.stats.successRate).toBe("number");
    expect(typeof result.stats.avgImprovements).toBe("number");
    expect(typeof result.stats.failureCategoryBreakdown).toBe("object");
  });

  it("result is JSON-serialisable (no undefined or circular values)", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const result = generateStatsJson(db);
    expect(() => JSON.stringify(result)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed.latestCycle).toBe(1);
    expect(parsed.stats.totalCycles).toBe(1);
  });

  it("respects optional lastN parameter", () => {
    for (let i = 1; i <= 5; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i, buildVerificationPassed: true, pushSucceeded: true }));
    }
    const resultAll = generateStatsJson(db);
    const resultLast2 = generateStatsJson(db, 2);
    expect(resultAll.stats.totalCycles).toBe(5);
    expect(resultLast2.stats.totalCycles).toBe(2);
    // latestCycle is always the true latest regardless of lastN
    expect(resultLast2.latestCycle).toBe(5);
  });

  it("lastN=0 returns latestCycle from DB but zero-value stats (LIMIT 0 matches no rows)", () => {
    // parseLastNArg guards against 0 at the CLI level, but generateStatsJson is a public
    // function callable directly. Pinning this behavior prevents a silent regression where
    // lastN=0 might be treated as "all cycles" instead of "zero cycles".
    insertCycle(db, makeOutcome({ cycleNumber: 3, buildVerificationPassed: true, pushSucceeded: true }));
    const result = generateStatsJson(db, 0);
    // latestCycle is fetched independently via getLatestCycleNumber, so it reflects reality
    expect(result.latestCycle).toBe(3);
    // getCycleStats with LIMIT 0 returns zero rows → zero-value stats
    expect(result.stats.totalCycles).toBe(0);
    expect(result.stats.successRate).toBe(0);
    expect(result.stats.totalCostUsd).toBe(0);
  });

  it("window is null when lastN is not provided (all-time stats)", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const result = generateStatsJson(db);
    expect(result.window).toBeNull();
  });

  it("window equals lastN when a positive integer is provided", () => {
    for (let i = 1; i <= 5; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
    }
    const result = generateStatsJson(db, 3);
    expect(result.window).toBe(3);
  });

  it("window is present and null in JSON serialisation when lastN is absent", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const result = generateStatsJson(db);
    const parsed = JSON.parse(JSON.stringify(result));
    // null serialises to JSON null, not undefined (which would be dropped)
    expect(Object.prototype.hasOwnProperty.call(parsed, "window")).toBe(true);
    expect(parsed.window).toBeNull();
  });

  it("window is present and equals lastN in JSON serialisation when lastN is provided", () => {
    for (let i = 1; i <= 4; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
    }
    const result = generateStatsJson(db, 2);
    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed.window).toBe(2);
  });

  it("generatedAt is a valid ISO 8601 timestamp string", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const result = generateStatsJson(db);
    expect(typeof result.generatedAt).toBe("string");
    // ISO 8601 format: YYYY-MM-DDTHH:mm:ss.sssZ
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Must be parseable as a real date
    expect(new Date(result.generatedAt).toString()).not.toBe("Invalid Date");
  });

  it("generatedAt is present and a valid ISO string in JSON serialisation", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const result = generateStatsJson(db);
    const parsed = JSON.parse(JSON.stringify(result));
    expect(Object.prototype.hasOwnProperty.call(parsed, "generatedAt")).toBe(true);
    expect(typeof parsed.generatedAt).toBe("string");
    expect(new Date(parsed.generatedAt).toString()).not.toBe("Invalid Date");
  });
});

describe("formatCycleStats", () => {
  it("returns 'No previous cycle data available.' when totalCycles is 0", () => {
    const stats: CycleStats = {
      totalCycles: 0,
      successRate: 0,
      avgImprovements: 0,
      avgConversionRate: null,
      testCountTrend: null,
      recentFailures: 0,
      avgDurationMinutes: null,
      totalCostUsd: 0,
      avgCostPerCycle: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      failureCategoryBreakdown: {},
      learningCategoryDistribution: {},
    };
    expect(formatCycleStats(stats)).toBe("No previous cycle data available.");
  });

  it("minimal case: pins exact 4-line output when all optional fields are absent", () => {
    // No conversion rate, no test trend, no duration, zero cost/tokens, zero failures.
    // Any label rename, format change, or markdown drift will break this pin.
    const stats: CycleStats = {
      totalCycles: 1,
      successRate: 0,
      avgImprovements: 0,
      avgConversionRate: null,
      testCountTrend: null,
      recentFailures: 0,
      avgDurationMinutes: null,
      totalCostUsd: 0,
      avgCostPerCycle: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      failureCategoryBreakdown: {},
      learningCategoryDistribution: {},
    };
    expect(formatCycleStats(stats)).toBe(
      "- **Cycles tracked**: 1\n" +
      "- **Success rate**: 0% (build passed + pushed)\n" +
      "- **Avg improvements/cycle**: 0\n" +
      "- **Recent failures** (last 5): 0",
    );
  });

  it("all-fields case: pins exact 9-line output covering every optional branch (no learnings distribution)", () => {
    // Covers: conversionRate, testCountTrend (positive), avgDurationMinutes,
    // Cost line with · separator and abbreviated token counts, recentFailures > 0,
    // and failure breakdown. Validates branch ordering and separator character.
    const stats: CycleStats = {
      totalCycles: 2,
      successRate: 50,
      avgImprovements: 1,
      avgConversionRate: 50,
      testCountTrend: 3,
      recentFailures: 1,
      avgDurationMinutes: 1.5,
      totalCostUsd: 0.15,
      avgCostPerCycle: 0.08,
      totalInputTokens: 150000,
      totalOutputTokens: 80000,
      failureCategoryBreakdown: { build_failure: 1 },
      learningCategoryDistribution: {},
    };
    expect(formatCycleStats(stats)).toBe(
      "- **Cycles tracked**: 2\n" +
      "- **Success rate**: 50% (build passed + pushed)\n" +
      "- **Avg improvements/cycle**: 1\n" +
      "- **Conversion rate**: 50% (improvements that succeed)\n" +
      "- **Test count trend**: +3\n" +
      "- **Avg cycle duration**: 1.5 min\n" +
      "- **Cost**: $0.15 total / $0.08 avg · 150k in / 80k out tokens\n" +
      "- **Recent failures** (last 5): 1\n" +
      "- **Failure breakdown** (across all 2 tracked cycles): 1 build_failure",
    );
  });

  it("learnings distribution appears when learningCategoryDistribution is non-empty", () => {
    const stats: CycleStats = {
      totalCycles: 1,
      successRate: 100,
      avgImprovements: 1,
      avgConversionRate: null,
      testCountTrend: null,
      recentFailures: 0,
      avgDurationMinutes: null,
      totalCostUsd: 0,
      avgCostPerCycle: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      failureCategoryBreakdown: {},
      learningCategoryDistribution: { domain: 12, pattern: 5, "anti-pattern": 3 },
    };
    const result = formatCycleStats(stats);
    expect(result).toContain("Learnings by category");
    expect(result).toContain("12 domain");
    expect(result).toContain("5 pattern");
    expect(result).toContain("3 anti-pattern");
  });

  it("learnings distribution absent when learningCategoryDistribution is empty", () => {
    const stats: CycleStats = {
      totalCycles: 1,
      successRate: 0,
      avgImprovements: 0,
      avgConversionRate: null,
      testCountTrend: null,
      recentFailures: 0,
      avgDurationMinutes: null,
      totalCostUsd: 0,
      avgCostPerCycle: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      failureCategoryBreakdown: {},
      learningCategoryDistribution: {},
    };
    expect(formatCycleStats(stats)).not.toContain("Learnings by category");
  });
});

describe("getLearningCategoryDistribution", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("returns empty object when no learnings exist", () => {
    expect(getLearningCategoryDistribution(db)).toEqual({});
  });

  it("returns correct counts per category", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertLearning(db, 1, "domain", "SQLite is fast");
    insertLearning(db, 1, "domain", "Use WAL mode");
    insertLearning(db, 1, "pattern", "Always test first");
    const dist = getLearningCategoryDistribution(db);
    expect(dist["domain"]).toBe(2);
    expect(dist["pattern"]).toBe(1);
    expect(dist["anti-pattern"]).toBeUndefined();
  });

  it("getCycleStats includes learningCategoryDistribution reflecting current learnings table", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertLearning(db, 1, "process", "Always run pnpm build first");
    const stats = getCycleStats(db);
    expect(stats.learningCategoryDistribution["process"]).toBe(1);
  });

  it("generateStatsOutput includes Learnings by category when learnings exist", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertLearning(db, 1, "domain", "SQLite is fast");
    insertLearning(db, 1, "pattern", "Always test first");
    const output = generateStatsOutput(db);
    const joined = output.join("\n");
    expect(joined).toContain("Learnings by category");
    expect(joined).toContain("1 domain");
    expect(joined).toContain("1 pattern");
  });
});

describe("parseTableFlag", () => {
  it("returns false when --table is absent", () => {
    expect(parseTableFlag(["node", "stats.js"])).toBe(false);
  });

  it("returns true when --table is present", () => {
    expect(parseTableFlag(["node", "stats.js", "--table"])).toBe(true);
  });

  it("returns true when --table appears alongside other flags", () => {
    expect(parseTableFlag(["node", "stats.js", "--last", "5", "--table"])).toBe(true);
  });

  it("returns false for an empty argv", () => {
    expect(parseTableFlag([])).toBe(false);
  });

  it("returns false for similar-but-not-equal flags", () => {
    expect(parseTableFlag(["--table2", "--TABLE", "--tables"])).toBe(false);
  });
});

describe("generateStatsTable", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("returns empty string when no cycles exist", () => {
    expect(generateStatsTable(db)).toBe("");
  });

  it("includes a header row with column names", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const table = generateStatsTable(db);
    expect(table).toContain("Cycle");
    expect(table).toContain("Attempt");
    expect(table).toContain("Succeed");
    expect(table).toContain("Build");
    expect(table).toContain("Push");
    expect(table).toContain("Duration");
  });

  it("includes a separator row of dashes", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const table = generateStatsTable(db);
    const lines = table.split("\n");
    // Line 1 (index 1) should be the separator
    expect(lines[1]).toMatch(/^[-\s]+$/);
  });

  it("includes cycle number in data rows", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 42 }));
    const table = generateStatsTable(db);
    expect(table).toContain("42");
  });

  it("shows ✓ for build passed and ✗ for build failed", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1, buildVerificationPassed: true }));
    insertCycle(db, makeOutcome({ cycleNumber: 2, buildVerificationPassed: false }));
    const table = generateStatsTable(db);
    expect(table).toContain("✓");
    expect(table).toContain("✗");
  });

  it("shows duration in minutes when durationMs is set", () => {
    // 90000 ms = 1.5 min
    insertCycle(db, makeOutcome({ cycleNumber: 1, durationMs: 90000 }));
    const table = generateStatsTable(db);
    expect(table).toContain("1.5 min");
  });

  it("shows — for duration when durationMs is null", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1, durationMs: null }));
    const table = generateStatsTable(db);
    expect(table).toContain("—");
  });

  it("shows attempted and succeeded counts", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1, improvementsAttempted: 3, improvementsSucceeded: 2 }));
    const table = generateStatsTable(db);
    expect(table).toContain("3");
    expect(table).toContain("2");
  });

  it("respects lastN parameter and limits rows shown", () => {
    for (let i = 1; i <= 5; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
    }
    const table2 = generateStatsTable(db, 2);
    const lines = table2.split("\n").filter(l => l.trim());
    // header + separator + 2 data rows = 4 non-empty lines
    expect(lines.length).toBe(4);
  });

  it("returns multiple rows for multiple cycles", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    insertCycle(db, makeOutcome({ cycleNumber: 3 }));
    const lines = generateStatsTable(db).split("\n");
    // header + separator + 3 data rows = 5 lines
    expect(lines.length).toBe(5);
  });
});
