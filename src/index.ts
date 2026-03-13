import { query } from "@anthropic-ai/claude-agent-sdk";
import { initDb, getLatestCycleNumber, insertCycle, updateCycleOutcome } from "./db.js";
import { errorMessage } from "./errors.js";
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
} from "./lifecycle.js";
import { runBuildVerificationPhase, updatePlanningStatus, pushChangesPhase } from "./phases.js";
import { type PhaseUsage } from "./usage.js";
import { createOutcome, formatOutcomeForJournal, parseTestCount, parseTestTotal } from "./outcomes.js";
import { formatCycleSummaryWithDuration } from "./orchestrator.js";
import { loadEvolutionContext } from "./context.js";
import {
  runAssessmentPhase,
  runEvolutionPhase,
  createDefaultDeps,
} from "./agent-phases.js";

async function main() {
  const cycleStartTime = Date.now();
  const db = initDb();
  const cycleCount = getLatestCycleNumber(db) + 1;
  const outcome = createOutcome(cycleCount);
  console.log(`\n========================================`);
  console.log(`  Bloom Evolution — Cycle ${cycleCount}`);
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log(`========================================\n`);

  // Pre-flight check (before cycle row exists, safe to exit early)
  console.log("[preflight] Running build + test check...");
  const preflightStart = Date.now();
  const preflight = runPreflightCheck();
  const preflightMs = Date.now() - preflightStart;
  if (!preflight.passed) {
    console.error(`[preflight] FAILED after ${(preflightMs / 1000).toFixed(1)}s. Aborting evolution.`);
    db.close();
    process.exit(1);
  }
  outcome.preflightPassed = true;
  outcome.testCountBefore = parseTestCount(preflight.output);
  outcome.testTotalBefore = parseTestTotal(preflight.output);
  console.log(`[preflight] PASSED in ${(preflightMs / 1000).toFixed(1)}s (${outcome.testCountBefore ?? "?"}/${outcome.testTotalBefore ?? "?"} tests)`);

  setGitBotIdentity();

  // Insert cycle row (will be updated at end)
  insertCycle(db, outcome);
  commitDb(cycleCount, "start");

  // Create safety tag
  createSafetyTag(cycleCount);

  const deps = createDefaultDeps(query);
  const safetyHooks = { protectIdentity, protectJournal, blockDangerousCommands };

  let evolutionError: unknown = null;

  try {
    const ctx = await loadEvolutionContext(db, cycleCount);
    const phaseUsages: PhaseUsage[] = [];

    const assessment = await runAssessmentPhase(db, cycleCount, ctx, phaseUsages, deps);

    const processed = await runEvolutionPhase(
      db, cycleCount, outcome, assessment, ctx.identity, phaseUsages, deps, safetyHooks,
    );

    runBuildVerificationPhase(cycleCount, outcome);

    updatePlanningStatus(cycleCount, ctx.projectConfig, ctx.currentItem, processed);

    pushChangesPhase(outcome);
  } catch (err) {
    evolutionError = err;
    console.error(`\n[error] Evolution failed: ${errorMessage(err)}`);
  } finally {
    // Always persist outcome and close DB, even on errors
    updateCycleOutcome(db, outcome);
    db.close();
    console.log("[db] Outcome persisted and database closed.");
  }

  // Always commit and push DB so failure metrics are not lost
  console.log("\n[db] Committing database changes...");
  commitDb(cycleCount, "outcome");
  if (pushChanges()) {
    console.log("[db] Database changes pushed successfully.");
  } else {
    console.error("[db] Database push failed. Journal data remains local.");
  }
  pushTags();

  const totalMs = Date.now() - cycleStartTime;
  console.log(`\n${formatCycleSummaryWithDuration(cycleCount, outcome, evolutionError, totalMs)}\n`);
  console.log(formatOutcomeForJournal(outcome));

  // Exit with error code if the cycle failed, after DB has been committed/pushed
  if (evolutionError) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Evolution failed:", err);
  process.exit(1);
});
