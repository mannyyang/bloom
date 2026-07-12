import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initDb, insertCycle, insertPhaseUsage, insertStrategicContext, insertLearning, getCycleStats, formatCycleStats, getLearningCategoryDistribution, getLastUpdatedCyclePerCategory } from "../src/db.js";
import type { CycleStats } from "../src/db.js";
import { generateStatsOutput, parseIntArg, parseLastNArg, parseSinceArg, parseCategoryArg, parseSearchArg, parseJsonFlag, parseTableFlag, parseVerboseFlag, parseHelpFlag, parseTrendArg, parseCostAlertArg, checkCostAlert, generateStatsJson, generateStatsTable, generateStatsTrend, renderTrendBar, TREND_BAR_CHARS, STATS_MEMORY_PREVIEW_CHARS, STATS_NO_FAILURE_SYMBOL, STATS_NO_DURATION_SYMBOL, STATS_HELP_TEXT, STATS_NEXT_ITEM_HEADER, STATS_NO_ACTIONABLE_ITEMS_MSG, COL_FAILURES, COL_COST } from "../src/stats.js";
import { CYCLE_SUMMARY_SEPARATOR } from "../src/orchestrator.js";
import { ERROR_CATEGORY_NONE, ERROR_CATEGORY_BUILD_FAILURE, ERROR_CATEGORY_TEST_FAILURE, ERROR_CATEGORY_LLM_ERROR } from "../src/errors.js";
import { MAX_MEMORY_CHARS } from "../src/memory.js";
import { makeOutcome } from "./helpers.js";
import { DANGEROUS_PATTERNS } from "../src/safety.js";

describe("STATS_MEMORY_PREVIEW_CHARS", () => {
  it("is a positive number less than MAX_MEMORY_CHARS", () => {
    expect(STATS_MEMORY_PREVIEW_CHARS).toBe(1000);
    expect(STATS_MEMORY_PREVIEW_CHARS).toBeGreaterThan(0);
    expect(STATS_MEMORY_PREVIEW_CHARS).toBeLessThan(MAX_MEMORY_CHARS);
  });
});

describe("COL_FAILURES column-width invariants", () => {
  // All ErrorCategory values — update here when a new category is added.
  const allCategories = [
    ERROR_CATEGORY_NONE,
    ERROR_CATEGORY_BUILD_FAILURE,
    ERROR_CATEGORY_TEST_FAILURE,
    ERROR_CATEGORY_LLM_ERROR,
  ];

  it("COL_FAILURES is a positive integer", () => {
    expect(COL_FAILURES).toBeGreaterThan(0);
    expect(Number.isInteger(COL_FAILURES)).toBe(true);
  });

  it("COL_FAILURES is >= the length of every ErrorCategory string", () => {
    for (const cat of allCategories) {
      expect(COL_FAILURES).toBeGreaterThanOrEqual(cat.length);
    }
  });

  it("COL_FAILURES >= longest current ErrorCategory (build_failure = 13 chars)", () => {
    const longestLength = Math.max(...allCategories.map(c => c.length));
    expect(COL_FAILURES).toBeGreaterThanOrEqual(longestLength);
  });

  it("COL_FAILURES is 16 — pinned to detect accidental size reduction", () => {
    expect(COL_FAILURES).toBe(16);
  });
});

describe("parseHelpFlag", () => {
  it("returns false when --help is absent", () => {
    expect(parseHelpFlag(["node", "stats.js", "--table"])).toBe(false);
  });
  it("returns true when --help is present", () => {
    expect(parseHelpFlag(["node", "stats.js", "--help"])).toBe(true);
  });
  it("returns true when -h shorthand is present", () => {
    expect(parseHelpFlag(["node", "stats.js", "-h"])).toBe(true);
  });
});

describe("STATS_HELP_TEXT", () => {
  it("matches the exact expected help text", () => {
    expect(STATS_HELP_TEXT).toBe(
      `Usage: pnpm stats [options]\n` +
      `\n` +
      `Options:\n` +
      `  --last <N>            Show stats for the last N cycles only\n` +
      `  --since <N>           Show stats starting from cycle number N (inclusive)\n` +
      `  --category <CAT>      Filter to cycles matching failure_category (e.g. build_failure, none)\n` +
      `  --trend <N>           Show an ASCII success-rate bar for the last N cycles\n` +
      `  --cost-alert <USD>    Warn and exit non-zero when avg cost/cycle exceeds threshold\n` +
      `  --json                Output raw stats as JSON (for scripting/CI)\n` +
      `  --table               Output per-cycle data as an ASCII table\n` +
      `  --verbose             Include extra detail (staleness data, safety pattern count, or Failures column)\n` +
      `  --help, -h            Print this help message and exit\n`,
    );
  });
});

describe("parseCostAlertArg", () => {
  it("returns undefined when --cost-alert is absent", () => {
    expect(parseCostAlertArg(["node", "stats.js", "--table"])).toBeUndefined();
  });
  it("parses a valid float threshold", () => {
    expect(parseCostAlertArg(["node", "stats.js", "--cost-alert", "2.50"])).toBe(2.5);
  });
  it("parses an integer threshold", () => {
    expect(parseCostAlertArg(["node", "stats.js", "--cost-alert", "3"])).toBe(3);
  });
  it("parses zero as a valid threshold", () => {
    expect(parseCostAlertArg(["node", "stats.js", "--cost-alert", "0"])).toBe(0);
  });
  it("returns undefined when value is missing (next arg is a flag)", () => {
    expect(parseCostAlertArg(["node", "stats.js", "--cost-alert", "--table"])).toBeUndefined();
  });
  it("returns undefined when value is missing (flag is last arg)", () => {
    expect(parseCostAlertArg(["node", "stats.js", "--cost-alert"])).toBeUndefined();
  });
  it("returns undefined when value is non-numeric", () => {
    expect(parseCostAlertArg(["node", "stats.js", "--cost-alert", "abc"])).toBeUndefined();
  });
  it("returns undefined when value is negative", () => {
    expect(parseCostAlertArg(["node", "stats.js", "--cost-alert", "-1"])).toBeUndefined();
  });
});

describe("checkCostAlert", () => {
  it("returns null when avgCostPerCycle is below threshold", () => {
    expect(checkCostAlert(1.00, 2.50)).toBeNull();
  });
  it("returns null when avgCostPerCycle equals threshold", () => {
    expect(checkCostAlert(2.50, 2.50)).toBeNull();
  });
  it("returns a warning string when avgCostPerCycle exceeds threshold", () => {
    const result = checkCostAlert(3.00, 2.50);
    expect(result).not.toBeNull();
    expect(result).toContain("COST ALERT");
    expect(result).toContain("$3.00");
    expect(result).toContain("$2.50");
  });
  it("warning message format is pinned", () => {
    expect(checkCostAlert(3.00, 2.50)).toBe(
      "COST ALERT: avg cost/cycle $3.00 exceeds threshold $2.50",
    );
  });
});

describe("STATS_NO_FAILURE_SYMBOL", () => {
  it("is pinned to the em-dash character '—'", () => {
    expect(STATS_NO_FAILURE_SYMBOL).toBe("—");
  });
});

describe("STATS_NO_DURATION_SYMBOL", () => {
  it("is pinned to the em-dash character '—'", () => {
    expect(STATS_NO_DURATION_SYMBOL).toBe("—");
  });
  it("equals STATS_NO_FAILURE_SYMBOL so both columns share the same no-value glyph", () => {
    expect(STATS_NO_DURATION_SYMBOL).toBe(STATS_NO_FAILURE_SYMBOL);
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

  it("appends (last N cycles) to the title when lastN is provided", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 10 }));
    insertCycle(db, makeOutcome({ cycleNumber: 11 }));
    const output = generateStatsOutput(db, 5);
    expect(output[2]).toBe("  Bloom Evolution Statistics (last 5 cycles)");
  });

  it("does not append window label to title when lastN is undefined", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const output = generateStatsOutput(db, undefined);
    expect(output[2]).toBe("  Bloom Evolution Statistics");
  });

  it("appends (since cycle N) to the title when only sinceN is provided", () => {
    // Value-pin for the sinceN-only label path: output[2] must read "(since cycle N)"
    // when lastN is absent. Completes the window-label matrix alongside the lastN-only
    // and combined (lastN+sinceN) tests that exist elsewhere in this suite.
    insertCycle(db, makeOutcome({ cycleNumber: 10 }));
    insertCycle(db, makeOutcome({ cycleNumber: 15 }));
    const output = generateStatsOutput(db, undefined, undefined, 10);
    expect(output[2]).toBe("  Bloom Evolution Statistics (since cycle 10)");
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
      insertCycle(db, makeOutcome({ cycleNumber: 1, buildVerificationPassed: false, pushSucceeded: false, failureCategory: ERROR_CATEGORY_BUILD_FAILURE }));
      insertCycle(db, makeOutcome({ cycleNumber: 2, buildVerificationPassed: false, pushSucceeded: false, failureCategory: ERROR_CATEGORY_BUILD_FAILURE }));
      insertCycle(db, makeOutcome({ cycleNumber: 3, buildVerificationPassed: false, pushSucceeded: false, failureCategory: ERROR_CATEGORY_TEST_FAILURE }));
      insertCycle(db, makeOutcome({ cycleNumber: 4, buildVerificationPassed: false, pushSucceeded: false, failureCategory: ERROR_CATEGORY_LLM_ERROR }));
      insertCycle(db, makeOutcome({ cycleNumber: 5, buildVerificationPassed: true, pushSucceeded: true, failureCategory: ERROR_CATEGORY_NONE }));
      const stats = getCycleStats(db);
      expect(stats.failureCategoryBreakdown[ERROR_CATEGORY_BUILD_FAILURE]).toBe(2);
      expect(stats.failureCategoryBreakdown[ERROR_CATEGORY_TEST_FAILURE]).toBe(1);
      expect(stats.failureCategoryBreakdown[ERROR_CATEGORY_LLM_ERROR]).toBe(1);
      expect(stats.failureCategoryBreakdown[ERROR_CATEGORY_NONE]).toBeUndefined();
    });

    it("failure breakdown appears in generateStatsOutput when failures exist", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1, buildVerificationPassed: false, pushSucceeded: false, failureCategory: ERROR_CATEGORY_BUILD_FAILURE }));
      insertCycle(db, makeOutcome({ cycleNumber: 2, buildVerificationPassed: false, pushSucceeded: false, failureCategory: ERROR_CATEGORY_TEST_FAILURE }));
      const output = generateStatsOutput(db);
      const joined = output.join("\n");
      expect(joined).toContain(ERROR_CATEGORY_BUILD_FAILURE);
      expect(joined).toContain(ERROR_CATEGORY_TEST_FAILURE);
      expect(joined).toContain("Failure breakdown");
      expect(joined).toContain("across all");
    });

    it("failure breakdown omitted when all cycles have category none", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1, buildVerificationPassed: false, pushSucceeded: false, failureCategory: ERROR_CATEGORY_NONE }));
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

  it("verbose=false omits learningsStaleness from result", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const result = generateStatsJson(db, undefined, false);
    expect(Object.prototype.hasOwnProperty.call(result, "learningsStaleness")).toBe(false);
  });

  it("verbose=true includes learningsStaleness array even when no learnings exist", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const result = generateStatsJson(db, undefined, true);
    expect(Object.prototype.hasOwnProperty.call(result, "learningsStaleness")).toBe(true);
    expect(Array.isArray(result.learningsStaleness)).toBe(true);
    expect(result.learningsStaleness).toHaveLength(0);
  });

  it("verbose=true populates learningsStaleness with per-category data when learnings exist", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 3 }));
    insertCycle(db, makeOutcome({ cycleNumber: 5 }));
    insertLearning(db, 3, "architecture", "keep modules small");
    insertLearning(db, 5, "testing", "test edge cases");
    const result = generateStatsJson(db, undefined, true);
    expect(result.learningsStaleness).toBeDefined();
    expect(result.learningsStaleness!.length).toBe(2);
    // Ordered by lastCycle descending
    expect(result.learningsStaleness![0].category).toBe("testing");
    expect(result.learningsStaleness![0].lastCycle).toBe(5);
    expect(result.learningsStaleness![1].category).toBe("architecture");
    expect(result.learningsStaleness![1].lastCycle).toBe(3);
  });

  it("verbose=true result is JSON-serialisable and round-trips correctly", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    insertLearning(db, 2, "process", "run tests before commit");
    const result = generateStatsJson(db, undefined, true);
    expect(() => JSON.stringify(result)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(result));
    expect(Array.isArray(parsed.learningsStaleness)).toBe(true);
    expect(parsed.learningsStaleness[0].category).toBe("process");
    expect(parsed.learningsStaleness[0].lastCycle).toBe(2);
  });

  // Verify --json + --since composition: sinceN must actually filter stats rows.
  // This pins the behaviour so a future refactor cannot silently drop the filter.
  it("sinceN filters stats.totalCycles to only cycles >= sinceN", () => {
    for (let i = 1; i <= 5; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i, buildVerificationPassed: true, pushSucceeded: true }));
    }
    const result = generateStatsJson(db, undefined, false, 3);
    // cycles 3, 4, 5 match sinceN=3 → totalCycles must be 3
    expect(result.stats.totalCycles).toBe(3);
    // since field in output reflects the argument
    expect(result.since).toBe(3);
  });

  it("sinceN=1 with all cycles returns the full count", () => {
    for (let i = 1; i <= 4; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
    }
    const result = generateStatsJson(db, undefined, false, 1);
    expect(result.stats.totalCycles).toBe(4);
    expect(result.since).toBe(1);
  });

  it("sinceN beyond latest cycle returns zero stats but correct latestCycle", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    const result = generateStatsJson(db, undefined, false, 99);
    expect(result.stats.totalCycles).toBe(0);
    expect(result.latestCycle).toBe(2);
    expect(result.since).toBe(99);
  });

  it("sinceN=1 with 25 cycles returns all 25 (regression: not capped at CYCLE_STATS_HISTORY_LIMIT=20)", () => {
    // Regression test for the --since N truncation bug: when >20 cycles exist and
    // sinceN is set without lastN, stats must reflect all matching cycles, not just
    // the most recent CYCLE_STATS_HISTORY_LIMIT (20) ones.
    for (let i = 1; i <= 25; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i, buildVerificationPassed: true, pushSucceeded: true }));
    }
    const result = generateStatsJson(db, undefined, false, 1);
    expect(result.stats.totalCycles).toBe(25);
    expect(result.rows?.length).toBe(25);
  });

  it("rows field is present and is an array", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1, buildVerificationPassed: true, pushSucceeded: true }));
    insertCycle(db, makeOutcome({ cycleNumber: 2, buildVerificationPassed: false, pushSucceeded: false }));
    const result = generateStatsJson(db);
    expect(Array.isArray(result.rows)).toBe(true);
  });

  it("rows field length matches total cycles when no filters are active", () => {
    for (let i = 1; i <= 4; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
    }
    const result = generateStatsJson(db);
    expect(result.rows?.length).toBe(4);
  });

  it("rows field is filtered by lastN when lastN is provided", () => {
    for (let i = 1; i <= 5; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
    }
    const result = generateStatsJson(db, 2);
    expect(result.rows?.length).toBe(2);
  });

  it("rows field is filtered by sinceN when sinceN is provided", () => {
    for (let i = 1; i <= 5; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
    }
    const result = generateStatsJson(db, undefined, false, 3);
    // cycles 3, 4, 5 match sinceN=3
    expect(result.rows?.length).toBe(3);
  });

  it("rows field entries have expected CycleRow fields", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 7, buildVerificationPassed: true, pushSucceeded: true }));
    const result = generateStatsJson(db);
    const row = result.rows?.[0];
    expect(row).toBeDefined();
    expect(typeof row?.cycleNumber).toBe("number");
    expect(typeof row?.attempted).toBe("number");
    expect(typeof row?.succeeded).toBe("number");
    expect(typeof row?.buildPassed).toBe("boolean");
    expect(typeof row?.pushed).toBe("boolean");
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

describe("getLastUpdatedCyclePerCategory", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("returns empty array when no learnings exist", () => {
    expect(getLastUpdatedCyclePerCategory(db)).toEqual([]);
  });

  it("returns one entry per category with the max cycle number", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertCycle(db, makeOutcome({ cycleNumber: 3 }));
    insertLearning(db, 1, "pattern", "First learning");
    insertLearning(db, 3, "pattern", "Newer learning");
    insertLearning(db, 1, "domain", "Domain knowledge");
    const result = getLastUpdatedCyclePerCategory(db);
    const byCategory = Object.fromEntries(result.map(r => [r.category, r.lastCycle]));
    expect(byCategory["pattern"]).toBe(3);
    expect(byCategory["domain"]).toBe(1);
    expect(result.length).toBe(2);
  });

  it("orders results by lastCycle descending (most recently updated first)", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertCycle(db, makeOutcome({ cycleNumber: 5 }));
    insertCycle(db, makeOutcome({ cycleNumber: 10 }));
    insertLearning(db, 1, "process", "Old process learning");
    insertLearning(db, 5, "domain", "Mid domain learning");
    insertLearning(db, 10, "pattern", "Recent pattern learning");
    const result = getLastUpdatedCyclePerCategory(db);
    expect(result[0].lastCycle).toBeGreaterThanOrEqual(result[1].lastCycle);
    expect(result[1].lastCycle).toBeGreaterThanOrEqual(result[2].lastCycle);
    expect(result[0].category).toBe("pattern");
  });

  it("handles single category with multiple cycles correctly", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    insertCycle(db, makeOutcome({ cycleNumber: 8 }));
    insertLearning(db, 2, "anti-pattern", "Avoid mutation");
    insertLearning(db, 8, "anti-pattern", "Avoid globals");
    const result = getLastUpdatedCyclePerCategory(db);
    expect(result.length).toBe(1);
    expect(result[0].category).toBe("anti-pattern");
    expect(result[0].lastCycle).toBe(8);
  });
});

describe("generateStatsOutput verbose mode", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("does not include staleness block when verbose is false (default)", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertLearning(db, 1, "pattern", "Test-first development");
    const output = generateStatsOutput(db);
    expect(output.join("\n")).not.toContain("Learnings staleness");
  });

  it("does not include staleness block when verbose=true but no learnings exist", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const output = generateStatsOutput(db, undefined, true);
    expect(output.join("\n")).not.toContain("Learnings staleness");
  });

  it("includes staleness header when verbose=true and learnings exist", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertLearning(db, 1, "pattern", "Test-first development");
    const output = generateStatsOutput(db, undefined, true);
    expect(output.join("\n")).toContain("Learnings staleness (by category):");
  });

  it("includes one line per category with correct format", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 5 }));
    insertLearning(db, 5, "pattern", "Incremental changes");
    insertLearning(db, 5, "domain", "SQLite patterns");
    const output = generateStatsOutput(db, undefined, true);
    const joined = output.join("\n");
    expect(joined).toContain("  pattern: last updated cycle 5");
    expect(joined).toContain("  domain: last updated cycle 5");
  });

  it("shows the most recent cycle per category when a category spans multiple cycles", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 3 }));
    insertCycle(db, makeOutcome({ cycleNumber: 7 }));
    insertLearning(db, 3, "process", "First process learning");
    insertLearning(db, 7, "process", "Updated process learning");
    const output = generateStatsOutput(db, undefined, true);
    const joined = output.join("\n");
    // Should show cycle 7, not cycle 3
    expect(joined).toContain("  process: last updated cycle 7");
    expect(joined).not.toContain("  process: last updated cycle 3");
  });

  it("verbose output still ends with an empty string (trailing newline)", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertLearning(db, 1, "pattern", "Test-first");
    const output = generateStatsOutput(db, undefined, true);
    expect(output[output.length - 1]).toBe("");
  });

  it("non-verbose output length is unaffected by verbose flag being absent", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertLearning(db, 1, "pattern", "Always run tests before committing");
    const normalOutput = generateStatsOutput(db);
    expect(normalOutput).toHaveLength(10);
  });

  it("verbose output is longer than non-verbose when learnings exist", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertLearning(db, 1, "pattern", "Always run tests before committing");
    const normalOutput = generateStatsOutput(db);
    const verboseOutput = generateStatsOutput(db, undefined, true);
    expect(verboseOutput.length).toBeGreaterThan(normalOutput.length);
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
    expect(table).toContain("Cost");
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

  it("shows STATS_NO_DURATION_SYMBOL for duration when durationMs is null", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1, durationMs: null }));
    const table = generateStatsTable(db);
    expect(table).toContain(STATS_NO_DURATION_SYMBOL);
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

  it("lastN=0 returns empty string (no rows, same as no-cycles path)", () => {
    // parseLastNArg guards against 0 at the CLI level, but generateStatsTable
    // is a public function callable directly. Pinning this prevents a silent
    // regression where lastN=0 displays all rows instead of zero rows.
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    expect(generateStatsTable(db, 0)).toBe("");
  });

  it("returns multiple rows for multiple cycles", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    insertCycle(db, makeOutcome({ cycleNumber: 3 }));
    const lines = generateStatsTable(db).split("\n");
    // header + separator + 3 data rows = 5 lines
    expect(lines.length).toBe(5);
  });

  it("renders an exact data row for fully-known cycle values (non-verbose)", () => {
    // Pin the exact cell layout so a column-width or padding regression is
    // caught immediately. All inputs are fully-determined (no nulls).
    // No phase_usage inserted, so totalCostUsd=0 → Cost column shows "—".
    insertCycle(db, makeOutcome({
      cycleNumber: 7,
      improvementsAttempted: 2,
      improvementsSucceeded: 1,
      buildVerificationPassed: true,
      pushSucceeded: true,
      durationMs: 90000, // 1.5 min
    }));
    const lines = generateStatsTable(db).split("\n");
    const dataRow = lines[2]; // header, separator, first data row
    // Reconstruct the expected cells using the same pad logic as stats.ts.
    const expectedCells = [
      "     7",      // padStart(6)
      "        2",   // padStart(9)
      "        1",   // padStart(9)
      "✓     ",      // padEnd(6)
      "✓    ",       // padEnd(5)
      "   1.5 min",  // padStart(10)
      "       —",    // padStart(8) — no phase_usage, cost=0 → em-dash
    ];
    expect(dataRow).toBe(expectedCells.join("  "));
  });

  it("shows em-dash in Cost column when no phase_usage exists for cycle", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const table = generateStatsTable(db);
    // Cost column header is present
    expect(table).toContain("Cost");
    // Data row shows STATS_NO_FAILURE_SYMBOL (em-dash) for zero cost
    const dataRow = table.split("\n")[2];
    expect(dataRow).toContain(STATS_NO_FAILURE_SYMBOL);
  });

  it("shows formatted $X.XX in Cost column when phase_usage has cost", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertPhaseUsage(db, 1, {
      phase: "assessment",
      totalCostUsd: 0.38,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      durationMs: 5000,
      numTurns: 5,
    });
    const table = generateStatsTable(db);
    expect(table).toContain("$0.38");
  });

  it("COL_COST is 8 — pinned to detect accidental size reduction", () => {
    expect(COL_COST).toBe(8);
  });

  it("rows are ordered newest-first (highest cycle number at top)", () => {
    // JSDoc documents "ordered newest-first" — this pin ensures a refactor
    // that changes the ORDER BY direction is caught immediately.
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    insertCycle(db, makeOutcome({ cycleNumber: 3 }));
    const lines = generateStatsTable(db).split("\n");
    // data rows start at index 2 (after header and separator)
    const dataLines = lines.slice(2);
    // Each data line is padded: cycle number appears right-aligned in the first column.
    // Cycle 3 (newest) must appear before cycle 1 (oldest).
    const firstDataCycle = parseInt(dataLines[0].trim().split(/\s+/)[0]);
    const lastDataCycle = parseInt(dataLines[dataLines.length - 1].trim().split(/\s+/)[0]);
    expect(firstDataCycle).toBeGreaterThan(lastDataCycle);
  });

  describe("combined lastN + sinceN interaction", () => {
    it("includes only rows that are both within lastN window AND >= sinceN", () => {
      // Insert 5 cycles numbered 1..5. With lastN=3, getCycleRows returns the
      // 3 newest: cycles 5, 4, 3 (newest-first). The subsequent sinceN=4 filter
      // then drops cycle 3, leaving only cycles 5 and 4 in the output.
      for (let i = 1; i <= 5; i++) {
        insertCycle(db, makeOutcome({ cycleNumber: i }));
      }
      const table = generateStatsTable(db, 3, false, 4);
      const lines = table.split("\n").filter(l => l.trim());
      // header + separator + 2 data rows (cycles 5 and 4)
      expect(lines.length).toBe(4);
      // Cycles 5 and 4 must appear; cycles 3, 2, 1 must not
      expect(table).toContain("5");
      expect(table).toContain("4");
      // Cycle 3 was in the lastN window but below sinceN — must be absent
      const dataRows = lines.slice(2); // skip header and separator
      expect(dataRows.every(row => !row.trimStart().startsWith("3"))).toBe(true);
    });

    it("returns empty string when sinceN is higher than all rows in the lastN window", () => {
      // Cycles 1..5 exist; lastN=2 fetches cycles 5 and 4; sinceN=10 filters both out.
      for (let i = 1; i <= 5; i++) {
        insertCycle(db, makeOutcome({ cycleNumber: i }));
      }
      expect(generateStatsTable(db, 2, false, 10)).toBe("");
    });

    it("works correctly with sparse high-numbered cycles: lastN window may include cycles below sinceN", () => {
      // Sparse cycle numbers: 1, 5, 100, 700. With lastN=3, getCycleRows returns
      // the 3 newest: [700, 100, 5] (newest-first). The sinceN=10 filter then drops
      // cycle 5, leaving only [700, 100]. This demonstrates the asymmetry: a user
      // expecting "the 3 newest cycles at or after cycle 10" gets 2 rows, not 3,
      // because cycle 5 consumed one of the lastN slots but falls below sinceN.
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      insertCycle(db, makeOutcome({ cycleNumber: 5 }));
      insertCycle(db, makeOutcome({ cycleNumber: 100 }));
      insertCycle(db, makeOutcome({ cycleNumber: 700 }));
      const table = generateStatsTable(db, 3, false, 10);
      const lines = table.split("\n").filter(l => l.trim());
      // header + separator + 2 data rows (cycles 700 and 100)
      expect(lines.length).toBe(4);
      // Cycles 700 and 100 must appear
      const dataRows = lines.slice(2);
      expect(dataRows[0].trimStart()).toMatch(/^700/);
      expect(dataRows[1].trimStart()).toMatch(/^100/);
      // Cycle 5 was in the lastN=3 window but below sinceN=10 — must be absent.
      // The right-padded cycle column for cycle 5 is "     5" (padStart(6)),
      // distinct from cycle 100 ("   100") and cycle 700 ("   700").
      expect(table).not.toContain("     5");
      // Cycle 1 was outside the lastN=3 window entirely — must also be absent.
      // "     1" (5 spaces + "1") won't match "   100" (3 spaces + "100").
      expect(table).not.toContain("     1");
    });
  });

  describe("verbose mode", () => {
    it("includes Failures column header when verbose=true", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      const table = generateStatsTable(db, undefined, true);
      expect(table).toContain("Failures");
    });

    it("does not include Failures column header when verbose is absent", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      const table = generateStatsTable(db);
      expect(table).not.toContain("Failures");
    });

    it("shows failure category in Failures column when category is not 'none'", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1, buildVerificationPassed: false, pushSucceeded: false, failureCategory: ERROR_CATEGORY_BUILD_FAILURE }));
      const table = generateStatsTable(db, undefined, true);
      expect(table).toContain(ERROR_CATEGORY_BUILD_FAILURE);
    });

    it("shows — in Failures column when failure category is 'none'", () => {
      // durationMs: 90000 renders "1.5 min" in the Duration column so the only
      // em-dash in the data row is the one produced by the Failures column.
      // This isolates the Failures column assertion from the Duration column.
      insertCycle(db, makeOutcome({ cycleNumber: 1, buildVerificationPassed: true, pushSucceeded: true, failureCategory: ERROR_CATEGORY_NONE, durationMs: 90000 }));
      const table = generateStatsTable(db, undefined, true);
      const lines = table.split("\n");
      const dataRow = lines[2]; // header, separator, first data row
      expect(dataRow).toContain("1.5 min"); // Duration column renders a real value, not the symbol
      expect(dataRow).toContain(STATS_NO_FAILURE_SYMBOL); // Failures column renders the no-value symbol
    });

    it("verbose table has one more column than non-verbose table", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      const normalTable = generateStatsTable(db);
      const verboseTable = generateStatsTable(db, undefined, true);
      const normalHeaderCols = normalTable.split("\n")[0].trim().split(/\s{2,}/);
      const verboseHeaderCols = verboseTable.split("\n")[0].trim().split(/\s{2,}/);
      expect(verboseHeaderCols.length).toBe(normalHeaderCols.length + 1);
    });

    it("verbose table separator row is longer than normal separator", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1 }));
      const normalSep = generateStatsTable(db).split("\n")[1];
      const verboseSep = generateStatsTable(db, undefined, true).split("\n")[1];
      expect(verboseSep.length).toBeGreaterThan(normalSep.length);
    });

    it("shows multiple failure categories correctly across rows", () => {
      insertCycle(db, makeOutcome({ cycleNumber: 1, failureCategory: ERROR_CATEGORY_BUILD_FAILURE }));
      insertCycle(db, makeOutcome({ cycleNumber: 2, failureCategory: ERROR_CATEGORY_TEST_FAILURE }));
      insertCycle(db, makeOutcome({ cycleNumber: 3, failureCategory: ERROR_CATEGORY_NONE }));
      const table = generateStatsTable(db, undefined, true);
      expect(table).toContain(ERROR_CATEGORY_BUILD_FAILURE);
      expect(table).toContain(ERROR_CATEGORY_TEST_FAILURE);
    });

    it("shows STATS_NO_DURATION_SYMBOL in verbose data row when durationMs is null", () => {
      // Use a non-none failureCategory so the em-dash in the data row is
      // unambiguously from the Duration column, not the Failures column.
      insertCycle(db, makeOutcome({ cycleNumber: 1, durationMs: null, failureCategory: ERROR_CATEGORY_BUILD_FAILURE }));
      const table = generateStatsTable(db, undefined, true);
      const dataRow = table.split("\n")[2]; // header, separator, first data row
      expect(dataRow).toContain(STATS_NO_DURATION_SYMBOL);
      expect(dataRow).toContain(ERROR_CATEGORY_BUILD_FAILURE); // confirms Failures column is present
    });

    it("renders ERROR_CATEGORY_LLM_ERROR in Failures column", () => {
      // Covers the llm_error branch in the Failures column rendering path,
      // which was previously untested in any table-rendering test.
      insertCycle(db, makeOutcome({ cycleNumber: 1, durationMs: 90000, failureCategory: ERROR_CATEGORY_LLM_ERROR }));
      const table = generateStatsTable(db, undefined, true);
      const dataRow = table.split("\n")[2]; // header, separator, first data row
      expect(dataRow).toContain(ERROR_CATEGORY_LLM_ERROR); // "llm_error" appears in the Failures column
      expect(dataRow).toContain("1.5 min"); // Duration column renders normally
    });
  });

  describe("combined sinceN + categoryFilter", () => {
    it("returns only rows that satisfy both sinceN and categoryFilter together", () => {
      // Insert 4 cycles: cycle 1 (none), cycle 2 (build_failure), cycle 3 (none), cycle 4 (build_failure)
      // With sinceN=2 and categoryFilter=build_failure, only cycles 2 and 4 match sinceN,
      // and of those only cycle 4 matches the category filter (cycle 2 >= sinceN=2 and has build_failure,
      // cycle 3 >= sinceN=2 but has none — filtered out by category).
      // Both cycle 2 and cycle 4 have build_failure and are >= sinceN=2, so both appear.
      insertCycle(db, makeOutcome({ cycleNumber: 1, failureCategory: ERROR_CATEGORY_NONE }));
      insertCycle(db, makeOutcome({ cycleNumber: 2, failureCategory: ERROR_CATEGORY_BUILD_FAILURE }));
      insertCycle(db, makeOutcome({ cycleNumber: 3, failureCategory: ERROR_CATEGORY_NONE }));
      insertCycle(db, makeOutcome({ cycleNumber: 4, failureCategory: ERROR_CATEGORY_BUILD_FAILURE }));
      const table = generateStatsTable(db, undefined, false, 2, ERROR_CATEGORY_BUILD_FAILURE);
      // Cycles 2 and 4 satisfy both sinceN=2 and categoryFilter=build_failure
      expect(table).toContain("2");
      expect(table).toContain("4");
      // Cycle 1 is excluded by sinceN (< 2); cycle 3 is excluded by categoryFilter (none ≠ build_failure)
      const dataRows = table.split("\n").slice(2); // skip header + separator
      expect(dataRows.length).toBe(2);
    });

    it("returns empty string when no rows satisfy both sinceN and categoryFilter", () => {
      // Cycles 1 and 2 have none category; sinceN=1 keeps both but categoryFilter=build_failure excludes both
      insertCycle(db, makeOutcome({ cycleNumber: 1, failureCategory: ERROR_CATEGORY_NONE }));
      insertCycle(db, makeOutcome({ cycleNumber: 2, failureCategory: ERROR_CATEGORY_NONE }));
      expect(generateStatsTable(db, undefined, false, 1, ERROR_CATEGORY_BUILD_FAILURE)).toBe("");
    });
  });
});

describe("parseVerboseFlag", () => {
  it("returns false when --verbose is absent", () => {
    expect(parseVerboseFlag(["node", "stats.js"])).toBe(false);
  });

  it("returns true when --verbose is present", () => {
    expect(parseVerboseFlag(["node", "stats.js", "--verbose"])).toBe(true);
  });

  it("returns true when --verbose appears alongside other flags", () => {
    expect(parseVerboseFlag(["node", "stats.js", "--table", "--verbose"])).toBe(true);
  });

  it("returns false for an empty argv", () => {
    expect(parseVerboseFlag([])).toBe(false);
  });

  it("returns false for similar-but-not-equal flags", () => {
    expect(parseVerboseFlag(["--verbose2", "--VERBOSE", "--verb"])).toBe(false);
  });
});

describe("--verbose flag behaviour", () => {
  it("--verbose is valid without --table (now shows staleness block in default output)", () => {
    // --verbose is now meaningful in both --table and default output modes.
    // Verify the flag combination is well-formed and does not clash.
    const argv = ["node", "stats.js", "--verbose"];
    expect(parseVerboseFlag(argv)).toBe(true);
    expect(parseTableFlag(argv)).toBe(false);
    // No warning should be emitted — --verbose has a real effect without --table
  });

  it("--verbose combined with --table is also valid", () => {
    const argv = ["node", "stats.js", "--verbose", "--table"];
    expect(parseVerboseFlag(argv)).toBe(true);
    expect(parseTableFlag(argv)).toBe(true);
  });
});

describe("parseIntArg", () => {
  it("returns the integer for a valid positive integer string", () => {
    expect(parseIntArg(["--flag", "10"], "--flag")).toBe(10);
    expect(parseIntArg(["--flag", "1"], "--flag")).toBe(1);
    expect(parseIntArg(["--flag", "999"], "--flag")).toBe(999);
  });

  it("returns undefined when the flag is absent", () => {
    expect(parseIntArg(["--other", "5"], "--flag")).toBeUndefined();
    expect(parseIntArg([], "--flag")).toBeUndefined();
  });

  it("returns undefined for zero (not a positive integer)", () => {
    expect(parseIntArg(["--flag", "0"], "--flag")).toBeUndefined();
  });

  it("returns undefined for negative values", () => {
    expect(parseIntArg(["--flag", "-1"], "--flag")).toBeUndefined();
    expect(parseIntArg(["--flag", "-100"], "--flag")).toBeUndefined();
  });

  it("returns undefined for float strings (rejected by /^\\d+$/ guard)", () => {
    // "3.7" would parseInt to 3, but the regex guard rejects non-digit chars
    expect(parseIntArg(["--flag", "3.7"], "--flag")).toBeUndefined();
    expect(parseIntArg(["--flag", "0.9"], "--flag")).toBeUndefined();
  });

  it("returns undefined for non-numeric strings", () => {
    expect(parseIntArg(["--flag", "notanumber"], "--flag")).toBeUndefined();
    expect(parseIntArg(["--flag", "abc"], "--flag")).toBeUndefined();
  });

  it("returns undefined when flag is the last argv item (no following value)", () => {
    expect(parseIntArg(["--flag"], "--flag")).toBeUndefined();
    expect(parseIntArg(["node", "script.js", "--flag"], "--flag")).toBeUndefined();
  });
});

describe("parseSinceArg", () => {
  it("returns undefined when --since is absent", () => {
    expect(parseSinceArg(["node", "stats.js"])).toBeUndefined();
  });

  it("returns the parsed integer for a valid --since N argument", () => {
    expect(parseSinceArg(["node", "stats.js", "--since", "100"])).toBe(100);
    expect(parseSinceArg(["--since", "1"])).toBe(1);
    expect(parseSinceArg(["--since", "600"])).toBe(600);
  });

  it("returns undefined when --since is given an invalid value", () => {
    expect(parseSinceArg(["--since", "notanumber"])).toBeUndefined();
    expect(parseSinceArg(["--since", "-5"])).toBeUndefined();
    expect(parseSinceArg(["--since", "0"])).toBeUndefined();
  });

  it("returns undefined when --since is the final argv item with no following value", () => {
    expect(parseSinceArg(["--since"])).toBeUndefined();
    expect(parseSinceArg(["node", "stats.js", "--since"])).toBeUndefined();
  });

  it("returns undefined for an empty argv", () => {
    expect(parseSinceArg([])).toBeUndefined();
  });
});

describe("generateStatsTable --since N", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("filters rows to only those with cycleNumber >= sinceN", () => {
    for (let i = 1; i <= 5; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
    }
    const table = generateStatsTable(db, undefined, undefined, 3);
    const lines = table.split("\n").filter(l => l.trim());
    // header + separator + rows for cycles 3, 4, 5 = 5 non-empty lines
    expect(lines.length).toBe(5);
  });

  it("returns empty string when sinceN is higher than all cycle numbers", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    expect(generateStatsTable(db, undefined, undefined, 999)).toBe("");
  });

  it("includes sinceN boundary cycle in results", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 10 }));
    insertCycle(db, makeOutcome({ cycleNumber: 20 }));
    const table = generateStatsTable(db, undefined, undefined, 10);
    expect(table).toContain("10");
    expect(table).toContain("20");
  });

  it("excludes cycles below sinceN", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 5 }));
    insertCycle(db, makeOutcome({ cycleNumber: 15 }));
    insertCycle(db, makeOutcome({ cycleNumber: 25 }));
    const table = generateStatsTable(db, undefined, undefined, 10);
    expect(table).not.toContain("     5"); // padded cycle 5 should be absent
    expect(table).toContain("15");
    expect(table).toContain("25");
  });
});

describe("generateStatsOutput --since N stat values", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("stats body reflects only cycles >= sinceN, not earlier ones", () => {
    // Cycles 1–3 all fail; cycles 4–5 all succeed.
    // With sinceN=4 the success rate should be 100%, not 40%.
    for (let i = 1; i <= 3; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i, buildVerificationPassed: false, pushSucceeded: false }));
    }
    for (let i = 4; i <= 5; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i, buildVerificationPassed: true, pushSucceeded: true }));
    }
    const output = generateStatsOutput(db, undefined, undefined, 4);
    const joined = output.join("\n");
    // With sinceN=4 only cycles 4 and 5 are counted — both succeeded → 100%
    expect(joined).toContain("100%");
    // The all-time rate over all 5 cycles would be 40%, which must not appear
    expect(joined).not.toContain("40%");
  });

  it("getCycleStats respects sinceN and totalCycles reflects the filtered window", () => {
    for (let i = 1; i <= 10; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
    }
    const stats = getCycleStats(db, undefined, 6);
    // Only cycles 6–10 (5 cycles) should be counted
    expect(stats.totalCycles).toBe(5);
  });

  it("generateStatsJson stats reflect sinceN window", () => {
    // Cycles 1–2 fail; cycle 3 succeeds.
    insertCycle(db, makeOutcome({ cycleNumber: 1, buildVerificationPassed: false, pushSucceeded: false }));
    insertCycle(db, makeOutcome({ cycleNumber: 2, buildVerificationPassed: false, pushSucceeded: false }));
    insertCycle(db, makeOutcome({ cycleNumber: 3, buildVerificationPassed: true, pushSucceeded: true }));
    const result = generateStatsJson(db, undefined, undefined, 3);
    // sinceN=3 means only cycle 3 counts → 1 cycle, 100% success rate
    expect(result.stats.totalCycles).toBe(1);
    expect(result.stats.successRate).toBe(100);
  });
});

describe("combined --since M and --last N flags", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("parseLastNArg and parseSinceArg both parse when both flags are present", () => {
    const argv = ["node", "stats.js", "--since", "50", "--last", "10"];
    expect(parseLastNArg(argv)).toBe(10);
    expect(parseSinceArg(argv)).toBe(50);
  });

  it("getCycleStats applies sinceN filter and lastN limit together", () => {
    // Insert cycles 1–10; call with sinceN=5 and lastN=3
    // Expected: cycles 10, 9, 8 (3 most recent that are >= 5)
    for (let i = 1; i <= 10; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
    }
    const stats = getCycleStats(db, 3, 5);
    expect(stats.totalCycles).toBe(3);
  });

  it("generateStatsOutput header includes both sinceN and lastN labels when both flags present", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 10 }));
    insertCycle(db, makeOutcome({ cycleNumber: 20 }));
    // When both are provided both labels appear in the window string
    const output = generateStatsOutput(db, 5, undefined, 10);
    expect(output[2]).toContain("since cycle 10");
    expect(output[2]).toContain("last 5 cycles");
  });

  it("generateStatsJson window and since fields are both set when both flags present", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const result = generateStatsJson(db, 5, undefined, 10);
    expect(result.window).toBe(5);
    expect(result.since).toBe(10);
  });
});

describe("generateStatsJson --since N", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("includes since field as null when sinceN is not provided", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const result = generateStatsJson(db);
    expect(result.since).toBeNull();
  });

  it("includes since field equal to sinceN when provided", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const result = generateStatsJson(db, undefined, undefined, 50);
    expect(result.since).toBe(50);
  });

  it("since field is present and null in JSON serialisation when sinceN absent", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const parsed = JSON.parse(JSON.stringify(generateStatsJson(db)));
    expect(Object.prototype.hasOwnProperty.call(parsed, "since")).toBe(true);
    expect(parsed.since).toBeNull();
  });

  it("since field round-trips correctly through JSON serialisation", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const parsed = JSON.parse(JSON.stringify(generateStatsJson(db, undefined, undefined, 42)));
    expect(parsed.since).toBe(42);
  });
});

describe("generateStatsTable verbose=true + sinceN combined", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("shows only cycles >= sinceN AND includes Failures column when verbose=true + sinceN set", () => {
    for (let i = 1; i <= 5; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
    }
    const table = generateStatsTable(db, undefined, true, 3);
    // Failures column must be present
    expect(table).toContain("Failures");
    // Only cycles 3, 4, 5 should appear — cycles 1 and 2 must be absent
    const lines = table.split("\n").filter(l => l.trim());
    // header + separator + 3 data rows
    expect(lines.length).toBe(5);
  });

  it("data rows contain failure category values with verbose=true + sinceN filter", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1, failureCategory: ERROR_CATEGORY_BUILD_FAILURE }));
    insertCycle(db, makeOutcome({ cycleNumber: 2, failureCategory: ERROR_CATEGORY_TEST_FAILURE }));
    insertCycle(db, makeOutcome({ cycleNumber: 3, failureCategory: ERROR_CATEGORY_NONE, buildVerificationPassed: true, pushSucceeded: true, durationMs: 90000 }));
    // sinceN=2 excludes cycle 1; verbose=true adds Failures column
    const table = generateStatsTable(db, undefined, true, 2);
    expect(table).toContain("Failures");
    expect(table).toContain(ERROR_CATEGORY_TEST_FAILURE);
    // cycle 1 (build_failure) excluded by sinceN filter
    expect(table).not.toContain(ERROR_CATEGORY_BUILD_FAILURE);
  });

  it("returns empty string when sinceN excludes all rows even with verbose=true", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    expect(generateStatsTable(db, undefined, true, 999)).toBe("");
  });
});

describe("generateStatsTable lastN + sinceN combined", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("applies lastN limit first then sinceN filter: only cycles >= sinceN appear", () => {
    for (let i = 1; i <= 10; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
    }
    // lastN=3 fetches cycles 10, 9, 8; sinceN=8 keeps all three (8, 9, 10 >= 8)
    const table = generateStatsTable(db, 3, undefined, 8);
    const lines = table.split("\n").filter(l => l.trim());
    // header + separator + 3 data rows
    expect(lines.length).toBe(5);
    expect(table).toContain("10");
    expect(table).toContain("9");
    expect(table).toContain("8");
  });

  it("sinceN further restricts the lastN window", () => {
    for (let i = 1; i <= 10; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
    }
    // lastN=5 fetches cycles 10, 9, 8, 7, 6; sinceN=9 keeps only 10, 9
    const table = generateStatsTable(db, 5, undefined, 9);
    const lines = table.split("\n").filter(l => l.trim());
    // header + separator + 2 data rows
    expect(lines.length).toBe(4);
    expect(table).toContain("10");
    expect(table).toContain("9");
    expect(table).not.toContain("     8"); // padded cycle 8 absent
  });

  it("returns empty string when sinceN excludes all rows in lastN window", () => {
    for (let i = 1; i <= 10; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
    }
    // lastN=3 fetches cycles 10, 9, 8 but sinceN=999 excludes them all
    expect(generateStatsTable(db, 3, undefined, 999)).toBe("");
  });
});

describe("generateStatsTable sinceN with >20 cycles regression", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("returns all cycles >= sinceN even when total cycles exceed CYCLE_STATS_HISTORY_LIMIT", () => {
    // Insert 25 cycles so the default 20-row cap would drop cycles 1–5
    for (let i = 1; i <= 25; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
    }
    // sinceN=3 should return cycles 3..25 = 23 rows, regardless of the 20-row default limit
    const table = generateStatsTable(db, undefined, undefined, 3);
    const dataLines = table.split("\n").filter(l => l.trim()).slice(2); // skip header + separator
    expect(dataLines.length).toBe(23);
    // Confirm cycle 3 is included (would be silently dropped before the fix)
    expect(table).toContain("     3"); // right-aligned cycle number 3
    // Confirm cycle 1 and 2 are absent
    expect(table).not.toContain("     1");
    expect(table).not.toContain("     2");
  });
});

describe("generateStatsOutput verbose=true + sinceN combined", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("stats reflect only cycles >= sinceN AND staleness block appears when verbose=true", () => {
    // Cycles 1–3 fail; cycles 4–5 succeed.
    for (let i = 1; i <= 3; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i, buildVerificationPassed: false, pushSucceeded: false }));
    }
    for (let i = 4; i <= 5; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i, buildVerificationPassed: true, pushSucceeded: true }));
    }
    insertLearning(db, 5, "pattern", "Incremental changes are safer");
    const output = generateStatsOutput(db, undefined, true, 4);
    const joined = output.join("\n");
    // sinceN=4 means only cycles 4–5 counted → 100% success
    expect(joined).toContain("100%");
    expect(joined).not.toContain("40%");
    // verbose=true means staleness block appears (learnings exist)
    expect(joined).toContain("Learnings staleness (by category):");
  });

  it("staleness block appears with sinceN active when learnings exist", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 10 }));
    insertCycle(db, makeOutcome({ cycleNumber: 20 }));
    insertLearning(db, 20, "domain", "SQLite index usage");
    const output = generateStatsOutput(db, undefined, true, 10);
    expect(output.join("\n")).toContain("Learnings staleness (by category):");
  });

  it("verbose=true + sinceN output is longer than non-verbose sinceN output when learnings exist", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    insertCycle(db, makeOutcome({ cycleNumber: 2 }));
    insertLearning(db, 2, "pattern", "Keep tests green");
    const normal = generateStatsOutput(db, undefined, false, 1);
    const verbose = generateStatsOutput(db, undefined, true, 1);
    expect(verbose.length).toBeGreaterThan(normal.length);
  });
});

describe("generateStatsJson verbose=true + sinceN combined", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("learningsStaleness is present when verbose=true and sinceN is set", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 5 }));
    insertCycle(db, makeOutcome({ cycleNumber: 10 }));
    insertLearning(db, 10, "architecture", "keep modules small");
    const result = generateStatsJson(db, undefined, true, 5);
    expect(Object.prototype.hasOwnProperty.call(result, "learningsStaleness")).toBe(true);
    expect(Array.isArray(result.learningsStaleness)).toBe(true);
    expect(result.learningsStaleness!.length).toBe(1);
    expect(result.learningsStaleness![0].category).toBe("architecture");
  });

  it("stats.totalCycles reflects only cycles >= sinceN when verbose=true and sinceN set", () => {
    // Cycles 1–4 exist; sinceN=3 should count only cycles 3 and 4
    for (let i = 1; i <= 4; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
    }
    const result = generateStatsJson(db, undefined, true, 3);
    expect(result.stats.totalCycles).toBe(2);
  });

  it("since field equals sinceN when verbose=true and sinceN are both set", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 7 }));
    const result = generateStatsJson(db, undefined, true, 7);
    expect(result.since).toBe(7);
    expect(Object.prototype.hasOwnProperty.call(result, "learningsStaleness")).toBe(true);
  });
});

describe("generateStatsOutput lastN + sinceN stats accuracy", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("success rate reflects only the intersection of lastN window and sinceN filter", () => {
    // Cycles 1–4 fail; cycles 5–10 succeed.
    for (let i = 1; i <= 4; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i, buildVerificationPassed: false, pushSucceeded: false }));
    }
    for (let i = 5; i <= 10; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i, buildVerificationPassed: true, pushSucceeded: true }));
    }
    // lastN=5 fetches cycles 10,9,8,7,6; sinceN=7 keeps cycles 10,9,8,7 (4 successes, 0 failures)
    const output = generateStatsOutput(db, 5, undefined, 7);
    const joined = output.join("\n");
    // All 4 remaining cycles pass → 100% success rate
    expect(joined).toContain("100%");
    // All-window rate (6 successes / 10 total = 60%) must not appear
    expect(joined).not.toContain("60%");
  });

  it("Cycles tracked count equals the filtered intersection of lastN and sinceN", () => {
    for (let i = 1; i <= 10; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
    }
    // lastN=6 fetches cycles 10,9,8,7,6,5; sinceN=8 keeps cycles 10,9,8 → 3 cycles
    const output = generateStatsOutput(db, 6, undefined, 8);
    const joined = output.join("\n");
    expect(joined).toContain("Cycles tracked");
    expect(joined).toContain("3");
  });
});

describe("generateStatsJson lastN + sinceN stats accuracy", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("stats.totalCycles reflects the intersection of lastN and sinceN filters", () => {
    for (let i = 1; i <= 10; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
    }
    // lastN=5 fetches cycles 10,9,8,7,6; sinceN=9 keeps cycles 10,9 → totalCycles=2
    const result = generateStatsJson(db, 5, undefined, 9);
    expect(result.stats.totalCycles).toBe(2);
  });

  it("stats.successRate reflects only cycles in the lastN + sinceN intersection", () => {
    // Cycles 1–5 fail; cycles 6–10 succeed.
    for (let i = 1; i <= 5; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i, buildVerificationPassed: false, pushSucceeded: false }));
    }
    for (let i = 6; i <= 10; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i, buildVerificationPassed: true, pushSucceeded: true }));
    }
    // lastN=6 fetches cycles 10,9,8,7,6,5; sinceN=7 keeps cycles 10,9,8,7 (all successes) → 100%
    const result = generateStatsJson(db, 6, undefined, 7);
    expect(result.stats.totalCycles).toBe(4);
    expect(result.stats.successRate).toBe(100);
  });
});

describe("STATS_NEXT_ITEM_HEADER constant", () => {
  it("is pinned to the expected string", () => {
    expect(STATS_NEXT_ITEM_HEADER).toBe("Next item selection:");
  });
});

describe("STATS_NO_ACTIONABLE_ITEMS_MSG constant", () => {
  it("is pinned to the expected string", () => {
    expect(STATS_NO_ACTIONABLE_ITEMS_MSG).toBe("No actionable items on the roadmap.");
  });
});

describe("generateStatsOutput verbose next-item selection block", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
  });

  it("verbose output includes STATS_NEXT_ITEM_HEADER", () => {
    const output = generateStatsOutput(db, undefined, true);
    expect(output.join("\n")).toContain(STATS_NEXT_ITEM_HEADER);
  });

  it("non-verbose output does NOT include STATS_NEXT_ITEM_HEADER", () => {
    const output = generateStatsOutput(db, undefined, false);
    expect(output.join("\n")).not.toContain(STATS_NEXT_ITEM_HEADER);
  });

  it("verbose output includes STATS_NO_ACTIONABLE_ITEMS_MSG when roadmap is absent/empty", () => {
    // Pass a non-existent path so readRoadmap() returns "" regardless of the
    // real ROADMAP.md on disk → parseRoadmap("") → []
    // → pickNextItemWithRationale([]) → rationale: null → renders STATS_NO_ACTIONABLE_ITEMS_MSG
    const output = generateStatsOutput(db, undefined, true, undefined, "/nonexistent/ROADMAP.md");
    expect(output.join("\n")).toContain(STATS_NO_ACTIONABLE_ITEMS_MSG);
  });

  it("verbose output still ends with empty string (trailing newline) when next-item block present", () => {
    const output = generateStatsOutput(db, undefined, true);
    expect(output[output.length - 1]).toBe("");
  });
});

describe("generateStatsOutput text mode when sinceN excludes all existing cycles", () => {
  // When latestCycle > 0 but sinceN > latestCycle, getCycleStats returns
  // totalCycles=0. generateStatsOutput should still produce a meaningful header
  // (it does NOT return early with "No evolution cycles recorded yet." because
  // the DB is non-empty) but the stats body should reflect a zero-cycle window.
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("does not return early 'No evolution cycles recorded yet.' when latestCycle>0 but sinceN excludes all", () => {
    for (let i = 1; i <= 5; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
    }
    // sinceN=999 is above all 5 existing cycles
    const output = generateStatsOutput(db, undefined, undefined, 999);
    const joined = output.join("\n");
    // Should show the stats header (latestCycle=5 is non-zero)
    expect(joined).toContain("Bloom Evolution Statistics");
    expect(joined).not.toBe("No evolution cycles recorded yet.");
  });

  it("header contains sinceN label when sinceN excludes all cycles", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 3 }));
    const output = generateStatsOutput(db, undefined, undefined, 999);
    // windowLabel uses sinceN
    expect(output[2]).toContain("since cycle 999");
  });

  it("stats body reports no-data message when sinceN excludes all cycles", () => {
    // When sinceN filters out all rows, formatCycleStats renders
    // "No previous cycle data available." (the zero-cycles fallback).
    for (let i = 1; i <= 3; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i }));
    }
    const output = generateStatsOutput(db, undefined, undefined, 100);
    const joined = output.join("\n");
    expect(joined).toContain("No previous cycle data available.");
  });
});

describe("parseCategoryArg", () => {
  it("returns undefined when --category is absent", () => {
    expect(parseCategoryArg(["node", "stats.js", "--table"])).toBeUndefined();
  });
  it("returns the value after --category", () => {
    expect(parseCategoryArg(["node", "stats.js", "--category", "build_failure"])).toBe("build_failure");
  });
  it("returns undefined when --category has no value", () => {
    expect(parseCategoryArg(["node", "stats.js", "--category"])).toBeUndefined();
  });
  it("returns undefined when --category is followed by another flag", () => {
    expect(parseCategoryArg(["node", "stats.js", "--category", "--json"])).toBeUndefined();
  });
  it("returns 'none' for --category none", () => {
    expect(parseCategoryArg(["node", "stats.js", "--category", "none"])).toBe("none");
  });
  it("returns 'test_failure' for --category test_failure", () => {
    expect(parseCategoryArg(["node", "stats.js", "--category", "test_failure"])).toBe("test_failure");
  });
});

describe("parseSearchArg", () => {
  it("returns undefined when --search flag is absent", () => {
    expect(parseSearchArg(["node", "stats.js", "--table"])).toBeUndefined();
  });
  it("returns the search term when --search has a valid value", () => {
    expect(parseSearchArg(["node", "stats.js", "--search", "hello"])).toBe("hello");
  });
  it("returns undefined when --search is followed by another flag (starts with --)", () => {
    expect(parseSearchArg(["node", "stats.js", "--search", "--json"])).toBeUndefined();
  });
  it("returns undefined when --search has no following value", () => {
    expect(parseSearchArg(["node", "stats.js", "--search"])).toBeUndefined();
  });
  it("returns undefined when --search is followed by an empty string (falsy val guard)", () => {
    // argv.indexOf("--search") finds it; argv[idx+1] === "" which is falsy,
    // so !val is true and the function returns undefined.
    expect(parseSearchArg(["node", "stats.js", "--search", ""])).toBeUndefined();
  });
  it("returns whitespace-only string as-is (trimming is caller's responsibility)", () => {
    // " " is truthy and doesn't start with "--", so the function returns it.
    // Callers like filterBySearchTerm trim internally, so the whitespace-only
    // search term correctly produces a no-op filter (all items returned).
    expect(parseSearchArg(["node", "stats.js", "--search", " "])).toBe(" ");
  });
});

describe("generateStatsTable with --category filter", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("returns only cycles matching the given category", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1, failureCategory: ERROR_CATEGORY_BUILD_FAILURE, buildVerificationPassed: false }));
    insertCycle(db, makeOutcome({ cycleNumber: 2, failureCategory: ERROR_CATEGORY_TEST_FAILURE, buildVerificationPassed: false }));
    insertCycle(db, makeOutcome({ cycleNumber: 3, failureCategory: ERROR_CATEGORY_BUILD_FAILURE, buildVerificationPassed: false }));
    const table = generateStatsTable(db, undefined, false, undefined, ERROR_CATEGORY_BUILD_FAILURE);
    expect(table).toContain("1");
    expect(table).toContain("3");
    // cycle 2 (test_failure) should not appear
    expect(table).not.toMatch(/^\s*2\s/m);
  });

  it("returns empty string when no cycles match the category filter", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1, failureCategory: ERROR_CATEGORY_BUILD_FAILURE }));
    const table = generateStatsTable(db, undefined, false, undefined, ERROR_CATEGORY_LLM_ERROR);
    expect(table).toBe("");
  });

  it("--category none returns only cycles with failure_category = none", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1, failureCategory: ERROR_CATEGORY_NONE }));
    insertCycle(db, makeOutcome({ cycleNumber: 2, failureCategory: ERROR_CATEGORY_BUILD_FAILURE }));
    const table = generateStatsTable(db, undefined, false, undefined, ERROR_CATEGORY_NONE);
    expect(table).toContain("1");
    expect(table).not.toMatch(/^\s*2\s/m);
  });

  it("can combine --category with --last N", () => {
    for (let i = 1; i <= 5; i++) {
      insertCycle(db, makeOutcome({ cycleNumber: i, failureCategory: i % 2 === 0 ? ERROR_CATEGORY_BUILD_FAILURE : ERROR_CATEGORY_NONE }));
    }
    // lastN=10 (all), category=build_failure → cycles 2 and 4
    const table = generateStatsTable(db, 10, false, undefined, ERROR_CATEGORY_BUILD_FAILURE);
    expect(table).toContain("2");
    expect(table).toContain("4");
    expect(table).not.toMatch(/^\s*1\s/m);
    expect(table).not.toMatch(/^\s*3\s/m);
    expect(table).not.toMatch(/^\s*5\s/m);
  });
});

describe("generateStatsJson with --category filter", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("sets category field in output to the filter value", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1, failureCategory: ERROR_CATEGORY_BUILD_FAILURE }));
    const result = generateStatsJson(db, undefined, false, undefined, undefined, ERROR_CATEGORY_BUILD_FAILURE);
    expect(result.category).toBe(ERROR_CATEGORY_BUILD_FAILURE);
  });

  it("sets category field to null when no filter is given", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
    const result = generateStatsJson(db, undefined, false, undefined, undefined, undefined);
    expect(result.category).toBeNull();
  });

  it("stats reflect only matching cycles", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1, failureCategory: ERROR_CATEGORY_BUILD_FAILURE, buildVerificationPassed: false, pushSucceeded: false }));
    insertCycle(db, makeOutcome({ cycleNumber: 2, failureCategory: ERROR_CATEGORY_NONE, buildVerificationPassed: true, pushSucceeded: true }));
    // Filter to build_failure — only cycle 1 counted
    const result = generateStatsJson(db, undefined, false, undefined, undefined, ERROR_CATEGORY_BUILD_FAILURE);
    expect(result.stats.totalCycles).toBe(1);
  });

  it("stats reflect only cycles satisfying both sinceN AND categoryFilter together", () => {
    // 4 cycles: odd cycles are build_failure, even are none
    insertCycle(db, makeOutcome({ cycleNumber: 1, failureCategory: ERROR_CATEGORY_BUILD_FAILURE }));
    insertCycle(db, makeOutcome({ cycleNumber: 2, failureCategory: ERROR_CATEGORY_NONE }));
    insertCycle(db, makeOutcome({ cycleNumber: 3, failureCategory: ERROR_CATEGORY_BUILD_FAILURE }));
    insertCycle(db, makeOutcome({ cycleNumber: 4, failureCategory: ERROR_CATEGORY_NONE }));
    // sinceN=2 keeps cycles 2,3,4; categoryFilter=build_failure keeps only cycle 3
    const result = generateStatsJson(db, undefined, false, 2, undefined, ERROR_CATEGORY_BUILD_FAILURE);
    expect(result.stats.totalCycles).toBe(1);
  });
});

describe("generateStatsOutput with --category filter", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("includes category label in the window header", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1, failureCategory: ERROR_CATEGORY_BUILD_FAILURE }));
    const output = generateStatsOutput(db, undefined, undefined, undefined, undefined, ERROR_CATEGORY_BUILD_FAILURE);
    expect(output[2]).toContain("category: build_failure");
  });

  it("can combine sinceN and categoryFilter labels in header", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1, failureCategory: ERROR_CATEGORY_BUILD_FAILURE }));
    const output = generateStatsOutput(db, undefined, undefined, 1, undefined, ERROR_CATEGORY_BUILD_FAILURE);
    expect(output[2]).toContain("since cycle 1");
    expect(output[2]).toContain("category: build_failure");
  });

  it("stats count only cycles satisfying both sinceN AND categoryFilter together", () => {
    // 4 cycles: odd are build_failure, even are none
    insertCycle(db, makeOutcome({ cycleNumber: 1, failureCategory: ERROR_CATEGORY_BUILD_FAILURE }));
    insertCycle(db, makeOutcome({ cycleNumber: 2, failureCategory: ERROR_CATEGORY_NONE }));
    insertCycle(db, makeOutcome({ cycleNumber: 3, failureCategory: ERROR_CATEGORY_BUILD_FAILURE }));
    insertCycle(db, makeOutcome({ cycleNumber: 4, failureCategory: ERROR_CATEGORY_NONE }));
    // sinceN=2 keeps cycles 2,3,4; categoryFilter=build_failure keeps only cycle 3 → 1 total
    const output = generateStatsOutput(db, undefined, undefined, 2, undefined, ERROR_CATEGORY_BUILD_FAILURE);
    const joined = output.join("\n");
    expect(joined).toContain("Cycles tracked**: 1");
  });

  it("stats reflect only category-filtered cycles", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1, failureCategory: ERROR_CATEGORY_BUILD_FAILURE, buildVerificationPassed: false }));
    insertCycle(db, makeOutcome({ cycleNumber: 2, failureCategory: ERROR_CATEGORY_NONE, buildVerificationPassed: true, pushSucceeded: true }));
    const output = generateStatsOutput(db, undefined, undefined, undefined, undefined, ERROR_CATEGORY_BUILD_FAILURE);
    // Only 1 cycle should be counted — the formatted stats mention the cycle count
    const joined = output.join("\n");
    expect(joined).toContain("Cycles tracked**: 1");
  });
});

describe("Safety patterns count in verbose output", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
    insertCycle(db, makeOutcome({ cycleNumber: 1 }));
  });

  it("generateStatsOutput verbose includes 'Safety patterns:' line", () => {
    const output = generateStatsOutput(db, undefined, true, undefined, undefined, undefined);
    const joined = output.join("\n");
    expect(joined).toContain("Safety patterns:");
  });

  it("generateStatsOutput verbose safety pattern count matches DANGEROUS_PATTERNS.length", () => {
    const output = generateStatsOutput(db, undefined, true, undefined, undefined, undefined);
    const joined = output.join("\n");
    expect(joined).toContain(`Safety patterns: ${DANGEROUS_PATTERNS.length}`);
  });

  it("generateStatsOutput non-verbose does NOT include 'Safety patterns:' line", () => {
    const output = generateStatsOutput(db, undefined, false, undefined, undefined, undefined);
    const joined = output.join("\n");
    expect(joined).not.toContain("Safety patterns:");
  });

  it("generateStatsJson verbose includes dangerousPatternsCount field", () => {
    const result = generateStatsJson(db, undefined, true);
    expect(Object.prototype.hasOwnProperty.call(result, "dangerousPatternsCount")).toBe(true);
  });

  it("generateStatsJson verbose dangerousPatternsCount matches DANGEROUS_PATTERNS.length", () => {
    const result = generateStatsJson(db, undefined, true);
    expect(result.dangerousPatternsCount).toBe(DANGEROUS_PATTERNS.length);
  });

  it("generateStatsJson non-verbose omits dangerousPatternsCount field", () => {
    const result = generateStatsJson(db, undefined, false);
    expect(Object.prototype.hasOwnProperty.call(result, "dangerousPatternsCount")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseTrendArg
// ---------------------------------------------------------------------------

describe("parseTrendArg", () => {
  it("returns the positive integer after --trend", () => {
    expect(parseTrendArg(["node", "stats.js", "--trend", "10"])).toBe(10);
  });

  it("returns undefined when --trend is absent", () => {
    expect(parseTrendArg(["node", "stats.js", "--table"])).toBeUndefined();
  });

  it("returns undefined when --trend has no value", () => {
    expect(parseTrendArg(["node", "stats.js", "--trend"])).toBeUndefined();
  });

  it("returns undefined when --trend value is 0", () => {
    expect(parseTrendArg(["node", "stats.js", "--trend", "0"])).toBeUndefined();
  });

  it("returns undefined when --trend value is not a number", () => {
    expect(parseTrendArg(["node", "stats.js", "--trend", "abc"])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// renderTrendBar
// ---------------------------------------------------------------------------

describe("renderTrendBar", () => {
  it("returns empty string for empty rows array", () => {
    expect(renderTrendBar([])).toBe("");
  });

  it("renders full block for a successful cycle", () => {
    const rows = [{ cycleNumber: 1, attempted: 1, succeeded: 1, buildPassed: true, pushed: true, durationMs: null, failureCategory: null, totalCostUsd: 0 }];
    expect(renderTrendBar(rows)).toContain(TREND_BAR_CHARS[3]); // "█"
  });

  it("renders low block for a failed cycle", () => {
    const rows = [{ cycleNumber: 1, attempted: 0, succeeded: 0, buildPassed: false, pushed: false, durationMs: null, failureCategory: null, totalCostUsd: 0 }];
    expect(renderTrendBar(rows)).toContain(TREND_BAR_CHARS[0]); // "▁"
  });

  it("includes a trailing percentage", () => {
    const rows = [
      { cycleNumber: 1, attempted: 1, succeeded: 1, buildPassed: true, pushed: true, durationMs: null, failureCategory: null, totalCostUsd: 0 },
      { cycleNumber: 2, attempted: 1, succeeded: 1, buildPassed: true, pushed: true, durationMs: null, failureCategory: null, totalCostUsd: 0 },
    ];
    expect(renderTrendBar(rows)).toContain("100%");
  });

  it("computes 50% for one success and one failure", () => {
    const rows = [
      { cycleNumber: 1, attempted: 1, succeeded: 1, buildPassed: true, pushed: true, durationMs: null, failureCategory: null, totalCostUsd: 0 },
      { cycleNumber: 2, attempted: 0, succeeded: 0, buildPassed: false, pushed: false, durationMs: null, failureCategory: null, totalCostUsd: 0 },
    ];
    expect(renderTrendBar(rows)).toContain("50%");
  });

  it("renders oldest cycle first (reverse of input order)", () => {
    // Input is newest-first (as returned by getCycleRows). After .reverse(), oldest is leftmost.
    const rows = [
      { cycleNumber: 3, attempted: 1, succeeded: 1, buildPassed: false, pushed: false, durationMs: null, failureCategory: null, totalCostUsd: 0 }, // newest
      { cycleNumber: 2, attempted: 1, succeeded: 1, buildPassed: true, pushed: true, durationMs: null, failureCategory: null, totalCostUsd: 0 },
      { cycleNumber: 1, attempted: 1, succeeded: 1, buildPassed: true, pushed: true, durationMs: null, failureCategory: null, totalCostUsd: 0 },  // oldest
    ];
    const bar = renderTrendBar(rows);
    // oldest(1)=█, middle(2)=█, newest(3)=▁ → "██▁"
    expect(bar.startsWith(`${TREND_BAR_CHARS[3]}${TREND_BAR_CHARS[3]}${TREND_BAR_CHARS[0]}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// generateStatsTrend
// ---------------------------------------------------------------------------

describe("generateStatsTrend", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(":memory:");
  });

  it("returns 'No evolution cycles recorded yet.' when DB is empty", () => {
    expect(generateStatsTrend(db, 10)).toBe("No evolution cycles recorded yet.");
  });

  it("returns trend line containing 'Trend (last N):' prefix", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1, buildVerificationPassed: true, pushSucceeded: true }));
    insertCycle(db, makeOutcome({ cycleNumber: 2, buildVerificationPassed: false, pushSucceeded: false }));
    const result = generateStatsTrend(db, 5);
    expect(result).toContain("Trend (last 2):");
  });

  it("clamps to available cycles when trendN exceeds row count", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1, buildVerificationPassed: true, pushSucceeded: true }));
    const result = generateStatsTrend(db, 100);
    expect(result).toContain("Trend (last 1):");
  });

  it("includes the percentage in the output", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1, buildVerificationPassed: true, pushSucceeded: true }));
    insertCycle(db, makeOutcome({ cycleNumber: 2, buildVerificationPassed: true, pushSucceeded: true }));
    const result = generateStatsTrend(db, 10);
    expect(result).toContain("100%");
  });

  it("includes bar characters in the output", () => {
    insertCycle(db, makeOutcome({ cycleNumber: 1, buildVerificationPassed: true, pushSucceeded: true }));
    const result = generateStatsTrend(db, 5);
    // At least one of the bar chars must appear
    const hasBarChar = TREND_BAR_CHARS.some(c => result.includes(c));
    expect(hasBarChar).toBe(true);
  });
});
