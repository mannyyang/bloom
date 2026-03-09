import type Database from "better-sqlite3";
import { insertJournalEntry } from "./db.js";
import { parseEvolutionResult, countImprovements, extractResolvedIssueNumbers } from "./evolve.js";
import { extractLearnings, storeLearnings, storeStrategicContext } from "./memory.js";
import { closeResolvedIssue, hasCommitForIssue, type CommunityIssue } from "./issues.js";
import type { CycleOutcome } from "./outcomes.js";

/**
 * Result returned by processEvolutionResult with parsed data and applied side-effects.
 */
export interface ProcessedEvolution {
  journalSections: Record<string, string>;
  improvementsAttempted: number;
  improvementsSucceeded: number;
  learningsStored: number;
  strategicContextStored: boolean;
  issuesClosed: number[];
}

/**
 * Process the raw evolution result text: parse journal sections, store learnings,
 * store strategic context, count improvements, and close resolved issues.
 *
 * Extracted from index.ts main() to enable unit testing.
 */
export async function processEvolutionResult(
  db: Database.Database,
  cycleCount: number,
  evolutionResult: string,
  issues: CommunityIssue[],
): Promise<ProcessedEvolution> {
  // Parse journal sections from evolution result
  const journalSections = parseEvolutionResult(evolutionResult);
  for (const [section, content] of Object.entries(journalSections)) {
    if (content) {
      insertJournalEntry(db, cycleCount, section, content);
    }
  }

  // Extract and store learnings (best-effort)
  let learningsStored = 0;
  try {
    const extracted = extractLearnings(journalSections.learnings);
    storeLearnings(db, cycleCount, extracted);
    learningsStored = extracted.learnings.length;
  } catch {
    // Non-fatal
  }

  // Extract and store strategic context (best-effort)
  let strategicContextStored = false;
  try {
    const strategicCtx = journalSections.strategic_context;
    if (strategicCtx) {
      storeStrategicContext(db, cycleCount, strategicCtx);
      strategicContextStored = true;
    }
  } catch {
    // Non-fatal
  }

  // Populate improvement counts from parsed sections
  const improvementsAttempted = countImprovements(journalSections.attempted);
  const improvementsSucceeded = countImprovements(journalSections.succeeded);

  // Close issues mentioned in the succeeded section that have associated commits
  const openIssueNumbers = issues.map(i => i.number);
  const resolvedNumbers = extractResolvedIssueNumbers(journalSections.succeeded, openIssueNumbers);
  const issuesClosed: number[] = [];
  for (const issueNum of resolvedNumbers) {
    if (hasCommitForIssue(issueNum)) {
      const issue = issues.find(i => i.number === issueNum);
      await closeResolvedIssue(issueNum, cycleCount, `Addressed: ${issue?.title ?? `issue #${issueNum}`}`, db);
      issuesClosed.push(issueNum);
    }
  }

  return {
    journalSections,
    improvementsAttempted,
    improvementsSucceeded,
    learningsStored,
    strategicContextStored,
    issuesClosed,
  };
}

/**
 * Format the final cycle summary as a multi-line string.
 * Pure function — no side effects.
 */
export function formatCycleSummary(
  cycleCount: number,
  outcome: CycleOutcome,
  evolutionError: Error | null,
): string {
  const lines = [
    `========================================`,
    `  Cycle ${cycleCount} — ${evolutionError ? "FAILED" : "COMPLETE"}`,
    `  Duration: replaced-at-call-site`,
    `  Improvements: ${outcome.improvementsSucceeded}/${outcome.improvementsAttempted}`,
    `  Tests: ${outcome.testCountBefore ?? "?"} → ${outcome.testCountAfter ?? "?"}`,
    `  Build: ${outcome.buildVerificationPassed ? "PASSED" : "FAILED"}`,
    `  Push: ${outcome.pushSucceeded ? "OK" : "FAILED"}`,
    `========================================`,
  ];
  return lines.join("\n");
}

/**
 * Format the final cycle summary with actual duration.
 * Pure function — no side effects.
 */
export function formatCycleSummaryWithDuration(
  cycleCount: number,
  outcome: CycleOutcome,
  evolutionError: Error | null,
  totalMs: number,
): string {
  const lines = [
    `========================================`,
    `  Cycle ${cycleCount} — ${evolutionError ? "FAILED" : "COMPLETE"}`,
    `  Duration: ${(totalMs / 1000).toFixed(1)}s`,
    `  Improvements: ${outcome.improvementsSucceeded}/${outcome.improvementsAttempted}`,
    `  Tests: ${outcome.testCountBefore ?? "?"} → ${outcome.testCountAfter ?? "?"}`,
    `  Build: ${outcome.buildVerificationPassed ? "PASSED" : "FAILED"}`,
    `  Push: ${outcome.pushSucceeded ? "OK" : "FAILED"}`,
    `========================================`,
  ];
  return lines.join("\n");
}
