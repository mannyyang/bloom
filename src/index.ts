import { query } from "@anthropic-ai/claude-agent-sdk";
import { initDb, getLatestCycleNumber, insertCycle, insertJournalEntry, updateCycleOutcome } from "./db.js";
import { errorMessage, ERROR_CATEGORY_NONE, ERROR_CATEGORY_LLM_ERROR } from "./errors.js";
import {
  protectIdentity,
  protectJournal,
  blockDangerousCommands,
} from "./safety.js";
import {
  runPreflightCheck,
  setGitBotIdentity,
  commitDb,
  pushChanges,
  pushTags,
  createSafetyTag,
  writeCycleSummaryJson,
} from "./lifecycle.js";
import { runBuildVerificationPhase, updatePlanningStatus, pushChangesPhase } from "./phases.js";
import { type PhaseUsage, formatDurationSec } from "./usage.js";
import { createOutcome, formatOutcomeForJournal, parseTestCount, parseTestTotal, classifyBuildFailure, formatFailureTail } from "./outcomes.js";
import { formatCycleSummaryWithDuration, isDryRun } from "./orchestrator.js";
import { loadEvolutionContext } from "./context.js";
import {
  runAssessmentPhase,
  runEvolutionPhase,
  createDefaultDeps,
} from "./agent-phases.js";

async function main() {
  const cycleStartTime = Date.now();
  let db: ReturnType<typeof initDb> | null = null;
  let cycleCount = 0;
  let outcome = createOutcome(0);
  let evolutionError: unknown = null;

  try {
    db = initDb();
    cycleCount = getLatestCycleNumber(db) + 1;
    outcome = createOutcome(cycleCount);
    console.log(`\n========================================`);
    console.log(`  Bloom Evolution — Cycle ${cycleCount}`);
    console.log(`  Started: ${new Date().toISOString()}`);
    console.log(`========================================\n`);

    setGitBotIdentity();

    // Insert the cycle row up front so a preflight failure is still recorded
    // (visible in stats and the journal) rather than exiting silently. The row
    // is updated with final metrics in the finally block.
    insertCycle(db, outcome);

    // Pre-flight check
    console.log("[preflight] Running build + test check...");
    const preflightStart = Date.now();
    const preflight = runPreflightCheck();
    const preflightMs = Date.now() - preflightStart;
    if (!preflight.passed) {
      console.error(`[preflight] FAILED after ${formatDurationSec(preflightMs)}. Aborting evolution.`);
      outcome.failureCategory = classifyBuildFailure(preflight.output);
      outcome.failureDetail = formatFailureTail(preflight.output);
      throw new Error("Preflight build+test check failed before evolution could run.");
    }
    outcome.preflightPassed = true;
    outcome.testCountBefore = parseTestCount(preflight.output);
    outcome.testTotalBefore = parseTestTotal(preflight.output);
    console.log(`[preflight] PASSED in ${formatDurationSec(preflightMs)} (${outcome.testCountBefore ?? "?"}/${outcome.testTotalBefore ?? "?"} tests)`);

    // Persist the cycle row to git now that preflight has passed.
    if (!commitDb(cycleCount, "start")) {
      console.error("[db] Start commit produced no changes — cycle row may not be persisted to git.");
    }

    // Create safety tag
    createSafetyTag(cycleCount);

    const deps = createDefaultDeps(query);
    const safetyHooks = { protectIdentity, protectJournal, blockDangerousCommands };

    const ctx = await loadEvolutionContext(db, cycleCount);
    // Note: loadEvolutionContext already calls demoteStaleInProgressItems internally.
    const phaseUsages: PhaseUsage[] = [];

    const assessment = await runAssessmentPhase(db, cycleCount, ctx, phaseUsages, deps);

    if (isDryRun()) {
      console.log("[dryRun] BLOOM_DRY_RUN is set — skipping evolution, build verification, and push.");
      await updatePlanningStatus(cycleCount, ctx.projectConfig, ctx.currentItem, { improvementsSucceeded: 0, improvementsAttempted: 0 }, db ?? undefined);
      console.log("[dryRun] Assessment and planning status updated. Exiting cleanly.");
    } else {
      const processed = await runEvolutionPhase(
        db, cycleCount, outcome, assessment, ctx.identity, phaseUsages, deps, safetyHooks,
      );

      runBuildVerificationPhase(cycleCount, outcome);

      await updatePlanningStatus(cycleCount, ctx.projectConfig, ctx.currentItem, processed, db ?? undefined);

      pushChangesPhase(outcome);
    }
  } catch (err) {
    evolutionError = err;
    console.error(`\n[error] Evolution failed: ${errorMessage(err)}`);

    // Classify failure if not already set by a sub-phase (e.g. build verification)
    if (outcome.failureCategory === ERROR_CATEGORY_NONE) {
      outcome.failureCategory = ERROR_CATEGORY_LLM_ERROR;
    }

    // Record the error as a journal entry so it's visible on GitHub Pages.
    // When a build/test failure captured its output, also persist that as a
    // `failure_detail` entry so the next cycle can see *what* broke, not just
    // that something did.
    if (db && cycleCount > 0) {
      try {
        insertJournalEntry(db, cycleCount, "failed", `Evolution error: ${errorMessage(err)}`);
        if (outcome.failureDetail) {
          insertJournalEntry(db, cycleCount, "failure_detail", outcome.failureDetail);
        }
      } catch (journalErr) {
        console.warn(`[index] insertJournalEntry failed (non-fatal): ${journalErr}`);
      }
    }
  } finally {
    // Always persist outcome and close DB, even on errors
    if (db) {
      try {
        outcome.durationMs = Date.now() - cycleStartTime;
        updateCycleOutcome(db, outcome);
        console.log("[db] Outcome persisted.");
      } catch (err) {
        console.error(`[db] Failed to persist outcome: ${errorMessage(err)}`);
      }
      try {
        db.close();
      } catch (closeErr) {
        console.warn(`[index] db.close() failed (non-fatal): ${closeErr}`);
      }
    }
  }

  const totalMs = Date.now() - cycleStartTime;
  console.log(`\n${formatCycleSummaryWithDuration(cycleCount, outcome, evolutionError !== null, totalMs)}\n`);
  console.log(formatOutcomeForJournal(outcome));

  // Write structured cycle summary JSON before the outcome commit so it is
  // staged alongside bloom.db and pushed — external dashboards can then read
  // the latest summary between runs without SQLite access.
  if (cycleCount > 0) {
    writeCycleSummaryJson(outcome, "bloom-cycle-summary.json");
  }

  // Always commit and push DB so failure metrics are not lost
  if (cycleCount > 0) {
    console.log("\n[db] Committing database changes...");
    try {
      if (!commitDb(cycleCount, "outcome", ["bloom-cycle-summary.json"])) {
        console.error("[db] Outcome commit produced no changes — metrics may not be persisted to git.");
      }
      if (pushChanges()) {
        console.log("[db] Database changes pushed successfully.");
      } else {
        console.error("[db] Database push failed. Journal data remains local.");
      }
      if (!pushTags()) {
        console.error("[db] Tag push failed. Tags remain local.");
      }
    } catch (err) {
      console.error(`[db] Failed to commit/push: ${errorMessage(err)}`);
    }
  }

  // Exit with error code if the cycle failed, after DB has been committed/pushed
  if (evolutionError) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Evolution failed:", errorMessage(err));
  process.exit(1);
});
