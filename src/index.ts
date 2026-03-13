import { query } from "@anthropic-ai/claude-agent-sdk";
import { initDb, getLatestCycleNumber, insertCycle, updateCycleOutcome, insertPhaseUsage } from "./db.js";
import { buildAssessmentPrompt, buildEvolutionPrompt } from "./evolve.js";
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
import {
  extractUsage,
  aggregateUsage,
  formatPhaseUsage,
  formatCycleUsage,
  formatUsageForJournal,
  PhaseUsage,
} from "./usage.js";
import { createOutcome, formatOutcomeForJournal, parseTestCount, parseTestTotal } from "./outcomes.js";
import { processEvolutionResult, formatCycleSummaryWithDuration } from "./orchestrator.js";
import { loadEvolutionContext, type EvolutionContext } from "./context.js";
import type Database from "better-sqlite3";
import type { CycleOutcome } from "./outcomes.js";

/**
 * Run the read-only assessment phase using the Claude agent.
 * Returns the assessment text and populates phaseUsages.
 */
async function runAssessmentPhase(
  db: Database.Database,
  cycleCount: number,
  ctx: EvolutionContext,
  phaseUsages: PhaseUsage[],
): Promise<string> {
  console.log("\n========================================");
  console.log("  Phase 1: Assessment (read-only)");
  console.log("========================================");
  const assessmentStart = Date.now();
  let assessment = "";
  let assessmentTurns = 0;
  for await (const msg of query({
    prompt: buildAssessmentPrompt({
      identity: ctx.identity,
      journalSummary: ctx.journalSummary,
      cycleCount,
      cycleStatsText: ctx.cycleStatsText,
      memoryContext: ctx.memoryContext,
      planningContext: ctx.planningContext,
    }),
    options: {
      cwd: process.cwd(),
      model: "claude-opus-4-6",
      allowedTools: ["Read", "Glob", "Grep", "Bash"],
      permissionMode: "dontAsk",
      maxTurns: 20,
      maxBudgetUsd: 2.0,
    },
  })) {
    assessmentTurns++;
    if ("result" in msg) assessment = msg.result;
    const usage = extractUsage(msg, "Assessment");
    if (usage) {
      phaseUsages.push(usage);
      insertPhaseUsage(db, cycleCount, usage);
      console.log(formatPhaseUsage(usage));
    }
  }
  const assessmentMs = Date.now() - assessmentStart;

  if (!assessment) {
    throw new Error("Assessment produced no output. Aborting.");
  }

  console.log(`\n[assessment] Completed in ${(assessmentMs / 1000).toFixed(1)}s (${assessmentTurns} turns, ${assessment.length} chars)`);
  console.log(`[assessment] Output preview:\n${assessment.slice(0, 500)}${assessment.length > 500 ? "\n  ..." : ""}`);

  return assessment;
}

/**
 * Run the read-write evolution phase using the Claude agent.
 * Processes the result (journal, learnings, strategic context) and updates outcome.
 */
async function runEvolutionPhase(
  db: Database.Database,
  cycleCount: number,
  outcome: CycleOutcome,
  assessment: string,
  identity: string,
  phaseUsages: PhaseUsage[],
): Promise<ReturnType<typeof processEvolutionResult>> {
  console.log("\n========================================");
  console.log("  Phase 2: Evolution (read-write)");
  console.log("========================================");
  const evolutionStart = Date.now();
  const assessmentUsage = aggregateUsage(phaseUsages);
  const usageContext = formatUsageForJournal(assessmentUsage);
  const outcomeContext = formatOutcomeForJournal(outcome);
  let evolutionResult = "";
  let evolutionTurns = 0;
  for await (const msg of query({
    prompt: buildEvolutionPrompt(assessment, { usageContext, outcomeContext }),
    options: {
      cwd: process.cwd(),
      model: "claude-opus-4-6",
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      permissionMode: "acceptEdits",
      systemPrompt: identity,
      maxTurns: 50,
      maxBudgetUsd: 5.0,
      hooks: {
        PreToolUse: [
          { matcher: "Write|Edit", hooks: [protectIdentity, protectJournal] },
          { matcher: "Bash", hooks: [blockDangerousCommands] },
        ],
      },
    },
  })) {
    evolutionTurns++;
    if ("result" in msg) {
      evolutionResult = msg.result;
      console.log(msg.result);
    }
    const usage = extractUsage(msg, "Evolution");
    if (usage) {
      phaseUsages.push(usage);
      insertPhaseUsage(db, cycleCount, usage);
      console.log(formatPhaseUsage(usage));
    }
  }
  const evolutionMs = Date.now() - evolutionStart;
  console.log(`\n[evolution] Completed in ${(evolutionMs / 1000).toFixed(1)}s (${evolutionTurns} turns)`);

  // Log cycle usage summary
  const cycleUsage = aggregateUsage(phaseUsages);
  console.log("\n[usage] Cycle usage summary:");
  console.log(formatCycleUsage(cycleUsage));

  // Process evolution result: parse journal, store learnings, close resolved issues
  console.log("\n[journal] Processing evolution result...");
  const processed = processEvolutionResult(db, cycleCount, evolutionResult);
  for (const [section, content] of Object.entries(processed.journalSections)) {
    if (content) {
      console.log(`[journal] Stored section "${section}" (${content.length} chars)`);
    }
  }
  console.log(`[memory] Stored ${processed.learningsStored} learnings`);
  if (processed.strategicContextStored) {
    console.log(`[memory] Stored strategic context`);
  }
  outcome.improvementsAttempted = processed.improvementsAttempted;
  outcome.improvementsSucceeded = processed.improvementsSucceeded;
  console.log(`[outcome] Improvements: ${outcome.improvementsSucceeded}/${outcome.improvementsAttempted} succeeded`);

  return processed;
}

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

  let evolutionError: unknown = null;

  try {
    const ctx = await loadEvolutionContext(db, cycleCount);
    const phaseUsages: PhaseUsage[] = [];

    const assessment = await runAssessmentPhase(db, cycleCount, ctx, phaseUsages);

    const processed = await runEvolutionPhase(
      db, cycleCount, outcome, assessment, ctx.identity, phaseUsages,
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
