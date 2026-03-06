/**
 * Cycle outcome metrics for Bloom evolution cycles.
 * Captures structured success/failure data to answer "how are you measuring success?"
 */

import { readFileSync, writeFileSync } from "fs";

export interface CycleOutcome {
  cycleNumber: number;
  preflightPassed: boolean;
  improvementsAttempted: number;
  improvementsSucceeded: number;
  buildVerificationPassed: boolean;
  pushSucceeded: boolean;
  testCountBefore: number | null;
  testCountAfter: number | null;
}

/**
 * Parse the test count from pnpm test output.
 * Looks for patterns like "490 passed" in vitest output.
 * Returns null if the pattern is not found.
 */
export function parseTestCount(output: string): number | null {
  // Vitest format: "Tests  490 passed" (skip "Test Files  7 passed")
  const match = output.match(/Tests\s+(\d+)\s+passed/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
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
  };
}

/**
 * Format a CycleOutcome for inclusion in a journal entry.
 */
export function formatOutcomeForJournal(outcome: CycleOutcome): string {
  const lines: string[] = ["### Outcome Metrics", ""];

  lines.push(`- **Preflight**: ${outcome.preflightPassed ? "passed" : "failed"}`);
  lines.push(
    `- **Improvements**: ${outcome.improvementsSucceeded}/${outcome.improvementsAttempted} succeeded`,
  );
  lines.push(
    `- **Build verification**: ${outcome.buildVerificationPassed ? "passed" : "failed"}`,
  );
  lines.push(`- **Push**: ${outcome.pushSucceeded ? "succeeded" : "failed"}`);

  if (outcome.testCountBefore !== null && outcome.testCountAfter !== null) {
    const delta = outcome.testCountAfter - outcome.testCountBefore;
    const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
    lines.push(
      `- **Tests**: ${outcome.testCountBefore} before, ${outcome.testCountAfter} after (${deltaStr})`,
    );
  } else if (outcome.testCountBefore !== null) {
    lines.push(`- **Tests**: ${outcome.testCountBefore} before (after count unavailable)`);
  } else if (outcome.testCountAfter !== null) {
    lines.push(`- **Tests**: ${outcome.testCountAfter} after (before count unavailable)`);
  }

  return lines.join("\n");
}

const DEFAULT_METRICS_PATH = "METRICS.json";

/**
 * Load all persisted cycle outcomes from the metrics file.
 * Returns an empty array if the file does not exist or is invalid.
 */
export function loadOutcomes(path: string = DEFAULT_METRICS_PATH): CycleOutcome[] {
  try {
    const data = readFileSync(path, "utf-8");
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Persist a cycle outcome by appending it to the metrics JSON file.
 * Creates the file if it does not exist.
 */
export function persistOutcome(
  outcome: CycleOutcome,
  path: string = DEFAULT_METRICS_PATH,
): void {
  const existing = loadOutcomes(path);
  existing.push(outcome);
  writeFileSync(path, JSON.stringify(existing, null, 2) + "\n", "utf-8");
}
