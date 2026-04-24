import { describe, it, expect } from "vitest";
import {
  parseTestCount,
  parseTestTotal,
  createOutcome,
  formatOutcomeForJournal,
  classifyBuildFailure,
  OUTCOME_METRICS_HEADER,
} from "../src/outcomes.js";
import { makeOutcome } from "./helpers.js";

describe("OUTCOME_METRICS_HEADER", () => {
  it("has the expected value (value-pin)", () => {
    expect(OUTCOME_METRICS_HEADER).toBe("### Outcome Metrics");
  });
});

// Literal vitest v1/v2 summary block copied from a real run — pins the exact
// column-aligned format so parser regressions are caught immediately.
const REAL_VITEST_OUTPUT = ` ✓ tests/issues.test.ts (42)
 ✓ tests/triage.test.ts (31)
 ✓ tests/outcomes.test.ts (28)

 Test Files  3 passed (3)
      Tests  101 passed (101)
   Start at  09:15:22
   Duration  2.45s (transform 0.91s, setup 0ms, collect 1.20s, tests 0.34s, environment 4ms, prepare 1.11s)
`;

const REAL_VITEST_OUTPUT_MIXED = ` ✗ tests/issues.test.ts (42)
 ✓ tests/triage.test.ts (31)

 Test Files  1 failed | 1 passed (2)
      Tests  490 passed | 5 failed (495)
   Start at  10:00:00
   Duration  1.23s (transform 0.40s, setup 0ms, collect 0.82s, tests 0.23s, environment 2ms, prepare 0.66s)
`;

describe("parseTestCount", () => {
  it("parses vitest output with passed count", () => {
    expect(parseTestCount("Tests  490 passed")).toBe(490);
  });

  it("ignores Test Files line and only matches Tests line", () => {
    // Real vitest output has both "Test Files  N passed" and "Tests  N passed".
    // The parser must match only the "Tests" line (not "Test Files").
    const output = " Test Files  3 passed (3)\n      Tests  101 passed (101)\n";
    expect(parseTestCount(output)).toBe(101);
  });

  it("parses from multiline vitest output", () => {
    const output = `
 Test Files  7 passed (7)
      Tests  490 passed (490)
   Start at  19:02:38
`;
    expect(parseTestCount(output)).toBe(490);
  });

  it("parses passed count from real vitest output block", () => {
    expect(parseTestCount(REAL_VITEST_OUTPUT)).toBe(101);
  });

  it("parses passed count from real vitest mixed passed/failed output", () => {
    expect(parseTestCount(REAL_VITEST_OUTPUT_MIXED)).toBe(490);
  });

  it("returns null when no match found", () => {
    expect(parseTestCount("no test output here")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseTestCount("")).toBeNull();
  });

  it("parses single-digit count", () => {
    expect(parseTestCount("Tests  3 passed")).toBe(3);
  });

  it("parses large count", () => {
    expect(parseTestCount("Tests  1234 passed")).toBe(1234);
  });

  it("returns 0 when all tests fail (no passed token)", () => {
    expect(parseTestCount("Tests  5 failed (5)")).toBe(0);
  });

  it("returns 0 for all-failed multiline output", () => {
    const output = `
 Test Files  2 failed (2)
      Tests  5 failed (5)
   Start at  19:02:38
`;
    expect(parseTestCount(output)).toBe(0);
  });

  it("parses passed count with mixed passed/failed output", () => {
    expect(parseTestCount("Tests  490 passed | 5 failed (495)")).toBe(490);
  });

  it("parses passed count with passed/skipped output", () => {
    expect(parseTestCount("Tests  3 passed | 1 skipped (4)")).toBe(3);
  });

  it("returns 0 for skipped-only output (no passed or failed token)", () => {
    // "Tests  3 skipped (3)" has no "passed" or "failed" token → 0 passed
    expect(parseTestCount("Tests  3 skipped (3)")).toBe(0);
  });

  it("parses passed count from passed+skipped+failed output", () => {
    expect(parseTestCount("Tests  5 passed | 3 skipped | 2 failed (10)")).toBe(5);
  });
});

describe("parseTestTotal", () => {
  it("parses total from passed-only output", () => {
    expect(parseTestTotal("Tests  490 passed (490)")).toBe(490);
  });

  it("ignores Test Files line and only matches Tests line", () => {
    // Real vitest output has both "Test Files  N passed (N)" and "Tests  N passed (N)".
    // parseTestTotal must extract the count from the "Tests" line, not "Test Files".
    const output = " Test Files  3 passed (3)\n      Tests  101 passed (101)\n";
    expect(parseTestTotal(output)).toBe(101);
  });

  it("parses total from real vitest output block", () => {
    expect(parseTestTotal(REAL_VITEST_OUTPUT)).toBe(101);
  });

  it("parses total from real vitest mixed passed/failed output", () => {
    expect(parseTestTotal(REAL_VITEST_OUTPUT_MIXED)).toBe(495);
  });

  it("parses total from mixed passed/failed output", () => {
    expect(parseTestTotal("Tests  490 passed | 5 failed (495)")).toBe(495);
  });

  it("parses total from all-failed output", () => {
    expect(parseTestTotal("Tests  5 failed (5)")).toBe(5);
  });

  it("parses total from multiline vitest output", () => {
    const output = `
 Test Files  7 passed (7)
      Tests  490 passed (490)
   Start at  19:02:38
`;
    expect(parseTestTotal(output)).toBe(490);
  });

  it("returns null when no match found", () => {
    expect(parseTestTotal("no test output here")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseTestTotal("")).toBeNull();
  });

  it("parses total from passed/skipped output", () => {
    expect(parseTestTotal("Tests  3 passed | 1 skipped (4)")).toBe(4);
  });

  it("parses total from skipped-only output", () => {
    // "Tests  3 skipped (3)" — the generic regex matches the parenthesised total.
    expect(parseTestTotal("Tests  3 skipped (3)")).toBe(3);
  });

  it("parses total from passed+skipped+failed output", () => {
    expect(parseTestTotal("Tests  5 passed | 3 skipped | 2 failed (10)")).toBe(10);
  });

  it("returns null for output with no parentheses at all", () => {
    expect(parseTestTotal("build failed")).toBeNull();
  });

  it("returns null for parentheses containing non-numeric content", () => {
    expect(parseTestTotal("Tests  5 passed (abc)")).toBeNull();
  });
});

describe("createOutcome", () => {
  it("creates a default outcome for a given cycle", () => {
    const outcome = createOutcome(42);
    expect(outcome.cycleNumber).toBe(42);
    expect(outcome.preflightPassed).toBe(false);
    expect(outcome.improvementsAttempted).toBe(0);
    expect(outcome.improvementsSucceeded).toBe(0);
    expect(outcome.buildVerificationPassed).toBe(false);
    expect(outcome.pushSucceeded).toBe(false);
    expect(outcome.testCountBefore).toBeNull();
    expect(outcome.testCountAfter).toBeNull();
    expect(outcome.testTotalBefore).toBeNull();
    expect(outcome.testTotalAfter).toBeNull();
    expect(outcome.durationMs).toBeNull();
    expect(outcome.failureCategory).toBe("none");
  });
});

describe("formatOutcomeForJournal", () => {
  it("formats a fully successful outcome", () => {
    const outcome = makeOutcome({
      cycleNumber: 46, improvementsAttempted: 3, improvementsSucceeded: 3,
      buildVerificationPassed: true, pushSucceeded: true,
      testCountBefore: 490, testCountAfter: 505,
    });
    const result = formatOutcomeForJournal(outcome);
    expect(result).toContain("### Outcome Metrics");
    expect(result).toContain("**Preflight**: passed");
    expect(result).toContain("**Improvements**: 3/3 succeeded");
    expect(result).toContain("**Build verification**: passed");
    expect(result).toContain("**Push**: succeeded");
    expect(result).toContain("**Tests**: 490 before, 505 after (+15)");
  });

  it("formats a partially failed outcome", () => {
    const outcome = makeOutcome({
      cycleNumber: 46, improvementsAttempted: 3, improvementsSucceeded: 1,
      testCountBefore: 490, testCountAfter: 490,
    });
    const result = formatOutcomeForJournal(outcome);
    expect(result).toContain("**Improvements**: 1/3 succeeded");
    expect(result).toContain("**Build verification**: failed");
    expect(result).toContain("**Push**: failed");
    expect(result).toContain("(+0)");
  });

  it("formats outcome with negative test delta", () => {
    const outcome = makeOutcome({
      cycleNumber: 10, improvementsAttempted: 1,
      buildVerificationPassed: true, pushSucceeded: true,
      testCountBefore: 100, testCountAfter: 95,
    });
    const result = formatOutcomeForJournal(outcome);
    expect(result).toContain("(-5)");
  });

  it("handles null testCountBefore", () => {
    const outcome = makeOutcome({
      improvementsAttempted: 1, improvementsSucceeded: 1,
      buildVerificationPassed: true, pushSucceeded: true,
      testCountBefore: null, testCountAfter: 50,
    });
    const result = formatOutcomeForJournal(outcome);
    expect(result).toContain("50 after (before count unavailable)");
  });

  it("handles null testCountAfter", () => {
    const outcome = makeOutcome({
      improvementsAttempted: 1, improvementsSucceeded: 1,
      buildVerificationPassed: true, pushSucceeded: true,
      testCountBefore: 50, testCountAfter: null,
    });
    const result = formatOutcomeForJournal(outcome);
    expect(result).toContain("50 before (after count unavailable)");
  });

  it("includes total test counts when available", () => {
    const outcome = makeOutcome({
      cycleNumber: 46, improvementsAttempted: 2, improvementsSucceeded: 2,
      buildVerificationPassed: true, pushSucceeded: true,
      testCountBefore: 490, testCountAfter: 505,
      testTotalBefore: 495, testTotalAfter: 510,
    });
    const result = formatOutcomeForJournal(outcome);
    expect(result).toContain("total: 495 → 510");
  });

  it("omits total when test totals are null", () => {
    const outcome = makeOutcome({
      cycleNumber: 46, improvementsAttempted: 2, improvementsSucceeded: 2,
      buildVerificationPassed: true, pushSucceeded: true,
      testCountBefore: 490, testCountAfter: 505,
    });
    const result = formatOutcomeForJournal(outcome);
    expect(result).not.toContain("total:");
  });

  it("formats only-after test count when testCountBefore is null", () => {
    const outcome = makeOutcome({
      improvementsAttempted: 1, improvementsSucceeded: 1,
      buildVerificationPassed: true, pushSucceeded: true,
      testCountBefore: null, testCountAfter: 500,
    });
    const result = formatOutcomeForJournal(outcome);
    expect(result).toContain("500 after (before count unavailable)");
    expect(result).not.toContain("before,");
  });

  it("has exactly 8 lines for full happy-path with duration and both test counts but no totals", () => {
    // Pins the structural invariant for the most common success path:
    // header + blank + preflight + improvements + build + push + duration + tests = 8 lines.
    // failureCategory "none" is omitted; testTotals null suppresses the total suffix.
    // A regression that adds a spurious blank line or extra field would break this.
    const outcome = makeOutcome({
      preflightPassed: true,
      improvementsAttempted: 2,
      improvementsSucceeded: 2,
      buildVerificationPassed: true,
      pushSucceeded: true,
      failureCategory: "none",
      durationMs: 60000,
      testCountBefore: 100,
      testCountAfter: 103,
      testTotalBefore: null,
      testTotalAfter: null,
    });
    const result = formatOutcomeForJournal(outcome);
    const lines = result.split("\n");
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe("### Outcome Metrics");
    expect(lines[lines.length - 1]).toContain("103 after (+3)");
  });

  it("has exactly 7 lines for testCountBefore-only branch with failureCategory none and no duration", () => {
    // Pins the structural invariant: header + blank + preflight + improvements +
    // build + push + "before (after count unavailable)" = 7 lines.
    // A regression that inserts a spurious blank line would change this count.
    const outcome = makeOutcome({
      testCountBefore: 100,
      testCountAfter: null,
      failureCategory: "none",
      durationMs: null,
    });
    const result = formatOutcomeForJournal(outcome);
    const lines = result.split("\n");
    expect(lines).toHaveLength(7);
    expect(lines[lines.length - 1]).toContain("before (after count unavailable)");
  });

  it("handles both test counts null", () => {
    const outcome = makeOutcome({
      preflightPassed: false,
    });
    const result = formatOutcomeForJournal(outcome);
    expect(result).not.toContain("**Tests**");
  });

  it("includes section header", () => {
    const outcome = createOutcome(1);
    const result = formatOutcomeForJournal(outcome);
    expect(result.startsWith("### Outcome Metrics")).toBe(true);
  });

  it("renders Preflight as failed when preflightPassed is false", () => {
    const outcome = makeOutcome({ preflightPassed: false });
    const result = formatOutcomeForJournal(outcome);
    expect(result).toContain("**Preflight**: failed");
  });

  it("renders Preflight as passed when preflightPassed is true", () => {
    const outcome = makeOutcome({ preflightPassed: true });
    const result = formatOutcomeForJournal(outcome);
    expect(result).toContain("**Preflight**: passed");
  });

  it("includes Duration line when durationMs is present", () => {
    const outcome = makeOutcome({ durationMs: 12345 });
    const result = formatOutcomeForJournal(outcome);
    expect(result).toContain("**Duration**: 12.3s");
  });

  it("omits Duration line when durationMs is null", () => {
    const outcome = makeOutcome({ durationMs: null });
    const result = formatOutcomeForJournal(outcome);
    expect(result).not.toContain("**Duration**");
  });

  it("includes Duration line when durationMs is 0 (not null)", () => {
    // Guard: the check is `!== null`, so 0 is a valid duration (a cycle that
    // completed in < 1 ms) and must produce a Duration line, not be suppressed.
    const outcome = makeOutcome({ durationMs: 0 });
    const result = formatOutcomeForJournal(outcome);
    expect(result).toContain("**Duration**: 0.0s");
  });

  it("omits total when testTotalBefore is set but testTotalAfter is null", () => {
    const outcome = makeOutcome({
      cycleNumber: 46, improvementsAttempted: 2, improvementsSucceeded: 2,
      buildVerificationPassed: true, pushSucceeded: true,
      testCountBefore: 490, testCountAfter: 500,
      testTotalBefore: 495, testTotalAfter: null,
    });
    const result = formatOutcomeForJournal(outcome);
    expect(result).not.toContain("total:");
  });

  it("omits total when testTotalAfter is set but testTotalBefore is null", () => {
    const outcome = makeOutcome({
      cycleNumber: 46, improvementsAttempted: 2, improvementsSucceeded: 2,
      buildVerificationPassed: true, pushSucceeded: true,
      testCountBefore: 490, testCountAfter: 500,
      testTotalBefore: null, testTotalAfter: 505,
    });
    const result = formatOutcomeForJournal(outcome);
    expect(result).not.toContain("total:");
  });

  it("includes failure category line when failureCategory is build_failure", () => {
    const outcome = makeOutcome({ failureCategory: "build_failure" });
    const result = formatOutcomeForJournal(outcome);
    expect(result).toContain("**Failure category**: build_failure");
  });

  it("includes failure category line when failureCategory is test_failure", () => {
    const outcome = makeOutcome({ failureCategory: "test_failure" });
    const result = formatOutcomeForJournal(outcome);
    expect(result).toContain("**Failure category**: test_failure");
  });

  it("omits failure category line when failureCategory is none", () => {
    const outcome = makeOutcome({ failureCategory: "none" });
    const result = formatOutcomeForJournal(outcome);
    expect(result).not.toContain("**Failure category**");
  });
});

describe("parseTestCount/parseTestTotal null propagation round-trip", () => {
  // These tests pin the contract: malformed/changed vitest output → null parse result →
  // outcome with null test counts → formatOutcomeForJournal emits graceful output.
  // If the vitest output format drifts, breakage surfaces here rather than silently
  // producing wrong numbers in the journal.

  it("garbage input: both parsers return null → journal omits Tests line", () => {
    const raw = "error: module not found\nstderr: Cannot find module 'foo'";
    const countBefore = parseTestCount(raw);
    const totalBefore = parseTestTotal(raw);
    expect(countBefore).toBeNull();
    expect(totalBefore).toBeNull();
    const outcome = makeOutcome({ testCountBefore: countBefore, testCountAfter: null, testTotalBefore: totalBefore, testTotalAfter: null });
    const result = formatOutcomeForJournal(outcome);
    expect(result).not.toContain("**Tests**");
  });

  it("partial vitest output (count present, total missing) → journal shows count only, no total", () => {
    // A format where the parenthesised total is absent — parseTestTotal returns null
    const rawBefore = "Tests  10 passed";      // no parenthesised total
    const rawAfter  = "Tests  12 passed";
    const countBefore = parseTestCount(rawBefore); // 10
    const countAfter  = parseTestCount(rawAfter);  // 12
    const totalBefore = parseTestTotal(rawBefore); // null
    const totalAfter  = parseTestTotal(rawAfter);  // null
    expect(countBefore).toBe(10);
    expect(countAfter).toBe(12);
    expect(totalBefore).toBeNull();
    expect(totalAfter).toBeNull();
    const outcome = makeOutcome({ testCountBefore: countBefore, testCountAfter: countAfter, testTotalBefore: totalBefore, testTotalAfter: totalAfter });
    const result = formatOutcomeForJournal(outcome);
    // Counts are shown but no total suffix
    expect(result).toContain("**Tests**: 10 before, 12 after (+2)");
    expect(result).not.toContain("total:");
  });

  it("only testCountAfter available (before is null) → journal shows after count unavailable branch", () => {
    // Third branch: testCountBefore === null, testCountAfter !== null.
    // Exercises the "after (before count unavailable)" code path.
    const outcome = makeOutcome({ testCountBefore: null, testCountAfter: 55 });
    const result = formatOutcomeForJournal(outcome);
    expect(result).toContain("**Tests**: 55 after (before count unavailable)");
  });

  it("changed vitest format (no Tests keyword) → null parse → journal omits Tests line gracefully", () => {
    // Simulate a vitest format change where the summary keyword changes
    const raw = "Suites  5 passed (5)\n  Specs  490 all green (490)";
    const count = parseTestCount(raw); // null — regex not matched
    const total = parseTestTotal(raw); // null — no parenthesised Tests line
    expect(count).toBeNull();
    expect(total).toBeNull();
    const outcome = makeOutcome({ testCountBefore: 400, testCountAfter: count, testTotalBefore: 405, testTotalAfter: total });
    // Only before is available — should use the "after count unavailable" branch
    const result = formatOutcomeForJournal(outcome);
    expect(result).toContain("400 before (after count unavailable)");
    expect(result).not.toContain("total:");
  });
});

describe("classifyBuildFailure", () => {
  it("returns test_failure when vitest reports failed tests", () => {
    expect(classifyBuildFailure("Tests  5 failed (5)")).toBe("test_failure");
  });

  it("returns test_failure for mixed passed/failed vitest output", () => {
    expect(classifyBuildFailure("Tests  490 passed | 3 failed (493)")).toBe("test_failure");
  });

  it("returns build_failure for TypeScript compiler output (no test lines)", () => {
    expect(classifyBuildFailure("src/foo.ts(10,5): error TS2345: Argument of type")).toBe("build_failure");
  });

  it("returns build_failure for empty output", () => {
    expect(classifyBuildFailure("")).toBe("build_failure");
  });

  it("returns build_failure when build output has no vitest failure pattern", () => {
    expect(classifyBuildFailure("Tests  10 passed (10)")).toBe("build_failure");
  });

  it("returns test_failure for zero-count failed line (Tests  0 failed)", () => {
    // Regex /Tests\s+.*\d+\s+failed/ matches "0 failed" — pin this edge case
    expect(classifyBuildFailure("Tests  0 failed (0)")).toBe("test_failure");
  });

  it("returns test_failure when both passed and failed tokens appear (mixed run)", () => {
    expect(classifyBuildFailure("Tests  100 passed | 2 failed (102)")).toBe("test_failure");
  });

  it("returns build_failure for all-skipped vitest output (no failed token)", () => {
    // "Tests  3 skipped (3)" has no "failed" token so the regex does not match — pin this.
    expect(classifyBuildFailure("Tests  3 skipped (3)")).toBe("build_failure");
  });

  it("returns build_failure when only 'Test Files N failed' line is present (no Tests line)", () => {
    // "Test Files  2 failed (2)" is the per-file summary line, NOT the per-test line.
    // classifyBuildFailure must not treat it as a test_failure — pin this contract.
    expect(classifyBuildFailure("Test Files  2 failed (2)")).toBe("build_failure");
  });
});
