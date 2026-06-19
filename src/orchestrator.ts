import type Database from "better-sqlite3";
import { insertJournalEntry, CYCLE_SUMMARY_SEPARATOR } from "./db.js";
export { CYCLE_SUMMARY_SEPARATOR };
import { errorMessage, ERROR_CATEGORY_NONE } from "./errors.js";
import { parseEvolutionResult, countImprovements, type EvolutionSections } from "./evolve.js";
import { extractLearnings, storeLearnings, storeStrategicContext } from "./memory.js";
import type { CycleOutcome } from "./outcomes.js";
import { formatDurationSec } from "./usage.js";

/**
 * Returns true when the BLOOM_DRY_RUN environment variable is set to a
 * non-empty value.  Reading process.env at call-time (rather than module
 * initialisation time) keeps the function easy to test with vi.stubEnv.
 */
export function isDryRun(): boolean {
  return !!process.env.BLOOM_DRY_RUN;
}


/** Internal shape returned by the better-sqlite3 transaction in processEvolutionResult. */
interface WriteResult {
  learningsCount: number;
  dedupSkipped: number;
  strategicStored: boolean;
}

/**
 * Result returned by processEvolutionResult with parsed data and applied side-effects.
 */
export interface ProcessedEvolution {
  journalSections: EvolutionSections;
  succeededSummary: string;
  improvementsAttempted: number;
  improvementsSucceeded: number;
  learningsStored: number;
  strategicContextStored: boolean;
}

/**
 * Process the raw evolution result text: parse journal sections, store learnings,
 * store strategic context, and count improvements.
 *
 * All three DB write groups (journal entries, learnings, strategic context) are
 * wrapped in a single better-sqlite3 transaction so a crash mid-write cannot
 * leave partial state (e.g. a cycle with journal entries but no learnings).
 * If any write fails the entire transaction is rolled back and the error is
 * logged as non-fatal so the cycle can still complete.
 *
 * Issue lifecycle is now handled by the triage step (src/triage.ts), not here.
 */
export function processEvolutionResult(
  db: Database.Database,
  cycleCount: number,
  evolutionResult: string,
): ProcessedEvolution {
  // Parse journal sections from evolution result (pure, no DB writes)
  const journalSections = parseEvolutionResult(evolutionResult);

  // Extract learnings before entering the transaction (pure computation)
  let extracted;
  try {
    extracted = extractLearnings(journalSections.learnings);
  } catch (err) {
    console.error(`[orchestrator] Failed to extract learnings (non-fatal): ${errorMessage(err)}`);
    extracted = { learnings: [] };
  }

  // Perform all DB writes in a single atomic transaction.
  // Return values from the transaction function so they are only visible to
  // the caller if the transaction actually committed (not rolled back).
  let learningsStored = 0;
  let dedupSkipped = 0;
  let strategicContextStored = false;

  const doWrites = db.transaction((): WriteResult => {
    // 1. Journal entries
    for (const [section, content] of Object.entries(journalSections)) {
      if (content) {
        insertJournalEntry(db, cycleCount, section, content);
      }
    }

    // 2. Learnings (extracted above, outside the transaction)
    const learningsResult = storeLearnings(db, cycleCount, extracted);

    // 3. Strategic context
    const strategicCtx = journalSections.strategic_context;
    if (strategicCtx) {
      storeStrategicContext(db, cycleCount, strategicCtx);
    }

    return {
      learningsCount: learningsResult.count,
      dedupSkipped: learningsResult.dedupSkipped,
      strategicStored: !!strategicCtx,
    };
  });

  try {
    const writeResult = doWrites();
    learningsStored = writeResult.learningsCount;
    dedupSkipped = writeResult.dedupSkipped;
    strategicContextStored = writeResult.strategicStored;
  } catch (err) {
    console.error(`[orchestrator] Failed to persist evolution data (non-fatal, transaction rolled back): ${errorMessage(err)}`);
  }

  if (dedupSkipped > 0) {
    console.warn(`[orchestrator] storeLearnings: dedup skipped for ${dedupSkipped} learning(s) due to DB IO error — duplicates may exist`);
  }

  // Populate improvement counts from parsed sections
  const improvementsAttempted = countImprovements(journalSections.attempted);
  const improvementsSucceeded = countImprovements(journalSections.succeeded);

  return {
    journalSections,
    succeededSummary: journalSections.succeeded,
    improvementsAttempted,
    improvementsSucceeded,
    learningsStored,
    strategicContextStored,
  };
}

/**
 * Format a single test count for the cycle summary line.
 * Returns "passed/total" when both values are available (e.g. "490/490"),
 * just "passed" when the total is absent, or "?" when the count is null.
 * Exported for unit testing.
 */
export function formatTestCount(count: number | null, total: number | null): string {
  if (count === null) return "?";
  return total !== null ? `${count}/${total}` : `${count}`;
}

/**
 * Format the final cycle summary with actual duration.
 * Pure function — no side effects.
 */
export function formatCycleSummaryWithDuration(
  cycleCount: number,
  outcome: CycleOutcome,
  hadError: boolean,
  totalMs: number,
): string {
  const lines = [
    CYCLE_SUMMARY_SEPARATOR,
    `  Cycle ${cycleCount} — ${hadError ? "FAILED" : "COMPLETE"}`,
    `  Duration: ${formatDurationSec(totalMs)}`,
    `  Improvements: ${outcome.improvementsSucceeded}/${outcome.improvementsAttempted}`,
    `  Tests: ${formatTestCount(outcome.testCountBefore, outcome.testTotalBefore)} → ${formatTestCount(outcome.testCountAfter, outcome.testTotalAfter)}`,
    `  Build: ${outcome.buildVerificationPassed ? "PASSED" : "FAILED"}`,
    ...(outcome.failureCategory !== ERROR_CATEGORY_NONE ? [`  Failure: ${outcome.failureCategory}`] : []),
    `  Push: ${outcome.pushSucceeded ? "OK" : "FAILED"}`,
    CYCLE_SUMMARY_SEPARATOR,
  ];
  return lines.join("\n");
}
