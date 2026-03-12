import type Database from "better-sqlite3";
import { insertJournalEntry } from "./db.js";
import { errorMessage } from "./errors.js";
import { parseEvolutionResult, countImprovements } from "./evolve.js";
import { extractLearnings, storeLearnings, storeStrategicContext } from "./memory.js";
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
}

/**
 * Process the raw evolution result text: parse journal sections, store learnings,
 * store strategic context, and count improvements.
 *
 * Issue lifecycle is now handled by the triage step (src/triage.ts), not here.
 */
export function processEvolutionResult(
  db: Database.Database,
  cycleCount: number,
  evolutionResult: string,
): ProcessedEvolution {
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
  } catch (err) {
    console.error(`[orchestrator] Failed to store learnings (non-fatal): ${errorMessage(err)}`);
  }

  // Extract and store strategic context (best-effort)
  let strategicContextStored = false;
  try {
    const strategicCtx = journalSections.strategic_context;
    if (strategicCtx) {
      storeStrategicContext(db, cycleCount, strategicCtx);
      strategicContextStored = true;
    }
  } catch (err) {
    console.error(`[orchestrator] Failed to store strategic context (non-fatal): ${errorMessage(err)}`);
  }

  // Populate improvement counts from parsed sections
  const improvementsAttempted = countImprovements(journalSections.attempted);
  const improvementsSucceeded = countImprovements(journalSections.succeeded);

  return {
    journalSections,
    improvementsAttempted,
    improvementsSucceeded,
    learningsStored,
    strategicContextStored,
  };
}

/**
 * Format the final cycle summary with actual duration.
 * Pure function — no side effects.
 */
export function formatCycleSummaryWithDuration(
  cycleCount: number,
  outcome: CycleOutcome,
  evolutionError: unknown,
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
