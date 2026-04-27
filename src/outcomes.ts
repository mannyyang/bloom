/**
 * Cycle outcome metrics for Bloom evolution cycles.
 * Captures structured success/failure data to answer "how are you measuring success?"
 */

import type { ErrorCategory } from "./errors.js";
import { formatDurationSec } from "./usage.js";

/**
 * Markdown section header written at the top of every formatted outcome block.
 * Exported so tests can pin its exact value and callers can reference it without
 * relying on a hard-coded string literal.
 */
export const OUTCOME_METRICS_HEADER = "### Outcome Metrics";

export interface CycleOutcome {
  cycleNumber: number;
  preflightPassed: boolean;
  improvementsAttempted: number;
  improvementsSucceeded: number;
  buildVerificationPassed: boolean;
  pushSucceeded: boolean;
  testCountBefore: number | null;
  testCountAfter: number | null;
  testTotalBefore: number | null;
  testTotalAfter: number | null;
  durationMs: number | null;
  failureCategory: ErrorCategory;
}

/**
 * Parse the passed test count from pnpm test output.
 * Looks for patterns like "Tests  490 passed" in vitest output.
 * Also handles cases where all tests fail (e.g., "Tests  5 failed (5)") — returns 0 passed.
 * Also handles cases where all tests are skipped (e.g., "Tests  3 skipped (3)") — returns 0 passed.
 * Returns null if the pattern is not found.
 */
export function parseTestCount(output: string): number | null {
  // Vitest format: "Tests  490 passed" or "Tests  490 passed | 5 failed (495)"
  const passedMatch = output.match(/Tests\s+(\d+)\s+passed/);
  if (passedMatch) {
    return parseInt(passedMatch[1], 10);
  }
  // All tests failed: "Tests  5 failed (5)" with no "passed" token
  if (/Tests\s+\d+\s+failed\s+\(\d+\)/.test(output)) {
    return 0;
  }
  // All tests skipped: "Tests  3 skipped (3)" with no "passed" or "failed" token
  if (/Tests\s+\d+\s+skipped\s+\(\d+\)/.test(output)) {
    return 0;
  }
  return null;
}

/**
 * Parse the total test count from pnpm test output.
 * Looks for the parenthesized total in vitest output, e.g., "Tests  490 passed (490)"
 * or "Tests  3 passed | 2 failed (5)".
 * Returns null if the pattern is not found.
 */
export function parseTestTotal(output: string): number | null {
  // Vitest wraps the total in parentheses at the end of the Tests line
  const match = output.match(/Tests\s+.+\((\d+)\)/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Classify a build/test failure based on the captured output.
 * If vitest ran and reported failed tests, it's a test_failure.
 * Otherwise (TypeScript compiler error, missing module, etc.) it's a build_failure.
 */
export function classifyBuildFailure(output: string): ErrorCategory {
  // Vitest prints "Tests  N failed" or "Tests  N passed | N failed" when tests run and fail
  if (/Tests\s+.*\d+\s+failed/.test(output)) {
    return "test_failure";
  }
  return "build_failure";
}

/**
 * Create a default CycleOutcome for a given cycle number.
 * All metrics start at their "not yet determined" defaults.
 */
export function createOutcome(cycleNumber: number): CycleOutcome {
  return {
    cycleNumber,
    preflightPassed: false,
    improvementsAttempted: 0,
    improvementsSucceeded: 0,
    buildVerificationPassed: false,
    pushSucceeded: false,
    testCountBefore: null,
    testCountAfter: null,
    testTotalBefore: null,
    testTotalAfter: null,
    durationMs: null,
    failureCategory: "none",
  };
}

/**
 * Format a CycleOutcome for inclusion in a journal entry.
 */
export function formatOutcomeForJournal(outcome: CycleOutcome): string {
  const lines: string[] = [OUTCOME_METRICS_HEADER, ""];

  lines.push(`- **Preflight**: ${outcome.preflightPassed ? "passed" : "failed"}`);
  lines.push(
    `- **Improvements**: ${outcome.improvementsSucceeded}/${outcome.improvementsAttempted} succeeded`,
  );
  lines.push(
    `- **Build verification**: ${outcome.buildVerificationPassed ? "passed" : "failed"}`,
  );
  lines.push(`- **Push**: ${outcome.pushSucceeded ? "succeeded" : "failed"}`);

  if (outcome.failureCategory !== "none") {
    lines.push(`- **Failure category**: ${outcome.failureCategory}`);
  }

  if (outcome.durationMs !== null) {
    lines.push(`- **Duration**: ${formatDurationSec(outcome.durationMs)}`);
  }

  if (outcome.testCountBefore !== null && outcome.testCountAfter !== null) {
    const delta = outcome.testCountAfter - outcome.testCountBefore;
    const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
    let testLine = `- **Tests**: ${outcome.testCountBefore} before, ${outcome.testCountAfter} after (${deltaStr})`;
    if (outcome.testTotalBefore !== null && outcome.testTotalAfter !== null) {
      testLine += ` — total: ${outcome.testTotalBefore} → ${outcome.testTotalAfter}`;
    }
    lines.push(testLine);
  } else if (outcome.testCountBefore !== null) {
    lines.push(`- **Tests**: ${outcome.testCountBefore} before (after count unavailable)`);
  } else if (outcome.testCountAfter !== null) {
    lines.push(`- **Tests**: ${outcome.testCountAfter} after (before count unavailable)`);
  }

  return lines.join("\n");
}

