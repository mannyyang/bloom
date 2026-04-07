import { describe, it, expect } from "vitest";
import {
  parseTestCount,
  parseTestTotal,
  createOutcome,
  formatOutcomeForJournal,
  classifyBuildFailure,
} from "../src/outcomes.js";
import { makeOutcome } from "./helpers.js";

describe("parseTestCount", () => {
  it("parses vitest output with passed count", () => {
    expect(parseTestCount("Tests  490 passed")).toBe(490);
  });

  it("parses from multiline vitest output", () => {
    const output = `
 Test Files  7 passed (7)
      Tests  490 passed (490)
   Start at  19:02:38
`;
    expect(parseTestCount(output)).toBe(490);
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

  it("returns null for skipped-only output (no passed token)", () => {
    // "Tests  3 skipped (3)" has no "passed" token and no "failed" token,
    // so both regex branches miss and the function returns null.
    expect(parseTestCount("Tests  3 skipped (3)")).toBeNull();
  });

  it("parses passed count from passed+skipped+failed output", () => {
    expect(parseTestCount("Tests  5 passed | 3 skipped | 2 failed (10)")).toBe(5);
  });
});

describe("parseTestTotal", () => {
  it("parses total from passed-only output", () => {
    expect(parseTestTotal("Tests  490 passed (490)")).toBe(490);
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
});
