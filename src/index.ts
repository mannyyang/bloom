import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";
import { initDb, getLatestCycleNumber, insertCycle, updateCycleOutcome, insertPhaseUsage, getRecentJournalSummary, getCycleStats, formatCycleStats } from "./db.js";
import { fetchCommunityIssues } from "./issues.js";
import { triageIssues } from "./triage.js";
import { buildAssessmentPrompt, buildEvolutionPrompt } from "./evolve.js";
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
  runBuildVerification,
  createSafetyTag,
} from "./lifecycle.js";
import {
  extractUsage,
  aggregateUsage,
  formatPhaseUsage,
  formatCycleUsage,
  formatUsageForJournal,
  PhaseUsage,
} from "./usage.js";
import { createOutcome, formatOutcomeForJournal, parseTestCount, parseTestTotal } from "./outcomes.js";
import { formatMemoryForPrompt } from "./memory.js";
import { processEvolutionResult, formatCycleSummaryWithDuration } from "./orchestrator.js";
import { ensureProject, getProjectItems, pickNextItem, updateItemStatus, formatPlanningContext, type ProjectConfig, type ProjectItem } from "./planning.js";
import { commitRoadmap } from "./lifecycle.js";

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

  let evolutionError: Error | null = null;

  try {
    console.log("\n[context] Loading evolution context...");
    const identity = readFileSync("IDENTITY.md", "utf-8");
    console.log(`[context] Identity loaded (${identity.length} chars)`);

    const journalSummary = getRecentJournalSummary(db);
    console.log(`[context] Journal summary: ${journalSummary ? `${journalSummary.length} chars` : "empty"}`);

    const issues = await fetchCommunityIssues();
    console.log(`[context] Community issues: ${issues.length} open`);
    for (const issue of issues) {
      console.log(`  - #${issue.number}: ${issue.title} (${issue.reactions} reactions)`);
    }

    const cycleStats = getCycleStats(db);
    const cycleStatsText = formatCycleStats(cycleStats);
    console.log(`[context] Cycle stats: ${cycleStatsText ? `${cycleStatsText.length} chars` : "none"}`);

    // Memory context (best-effort)
    const memoryContext = formatMemoryForPrompt(db, 2000);
    console.log(`[context] Memory context: ${memoryContext ? `${memoryContext.length} chars` : "empty"}`);

    // Planning context (best-effort, uses ROADMAP.md)
    let planningContext = "";
    let projectConfig: ProjectConfig | null = null;
    let currentItem: ProjectItem | null = null;
    try {
      console.log("[planning] Loading roadmap...");
      projectConfig = ensureProject();
      if (projectConfig) {
        console.log(`[planning] Roadmap: ${projectConfig.filePath}`);
        let projectItems = getProjectItems(projectConfig);
        console.log(`[planning] ${projectItems.length} items on roadmap`);
        for (const item of projectItems) {
          console.log(`  - [${item.status ?? "No Status"}] ${item.title}${item.reactions > 0 ? ` (${item.reactions} reactions)` : ""}`);
        }

        // Triage community issues against the roadmap
        if (issues.length > 0) {
          console.log(`\n[triage] Triaging ${issues.length} community issues against roadmap...`);
          const triageResult = await triageIssues(issues, projectItems, cycleCount, projectConfig, db);
          if (triageResult.addedToBacklog.length > 0) {
            console.log(`[triage] Added to backlog: ${triageResult.addedToBacklog.map(n => `#${n}`).join(", ")}`);
          }
          if (triageResult.closed.length > 0) {
            console.log(`[triage] Closed: ${triageResult.closed.map(n => `#${n}`).join(", ")}`);
          }
          for (const d of triageResult.decisions) {
            console.log(`  - #${d.issueNumber}: ${d.action} — ${d.reason.slice(0, 100)}`);
          }
          // Re-fetch items since triage may have added new ones
          projectItems = getProjectItems(projectConfig);
          console.log(`[planning] ${projectItems.length} items on roadmap (post-triage)`);
        }

        currentItem = pickNextItem(projectItems);
        if (currentItem) {
          console.log(`[planning] Selected: "${currentItem.title}" → marking In Progress`);
          updateItemStatus(projectConfig, currentItem.id, "In Progress");
        } else {
          console.log("[planning] No actionable items found");
        }
        planningContext = formatPlanningContext(projectItems, currentItem);
      }
    } catch (err) {
      console.error(`[planning] Failed (non-fatal): ${(err as Error).message}`);
    }

    // Phase 1: Assessment (read-only)
    console.log("\n========================================");
    console.log("  Phase 1: Assessment (read-only)");
    console.log("========================================");
    const assessmentStart = Date.now();
    let assessment = "";
    const phaseUsages: PhaseUsage[] = [];
    let assessmentTurns = 0;
    for await (const msg of query({
      prompt: buildAssessmentPrompt({ identity, journalSummary, cycleCount, cycleStatsText, memoryContext, planningContext }),
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
      const usage = extractUsage(msg as Record<string, unknown>, "Assessment");
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

    // Phase 2: Evolution (read-write with safety hooks)
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
      const usage = extractUsage(msg as Record<string, unknown>, "Evolution");
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
    const processed = await processEvolutionResult(db, cycleCount, evolutionResult);
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

    // Phase 2.5: Post-evolution build verification
    console.log("\n========================================");
    console.log("  Build Verification");
    console.log("========================================");
    const buildStart = Date.now();
    const buildResult = runBuildVerification(cycleCount);
    const buildMs = Date.now() - buildStart;
    outcome.buildVerificationPassed = buildResult.passed;
    outcome.testCountAfter = parseTestCount(buildResult.output);
    outcome.testTotalAfter = parseTestTotal(buildResult.output);
    console.log(`[build] ${buildResult.passed ? "PASSED" : "FAILED"} in ${(buildMs / 1000).toFixed(1)}s (${outcome.testCountAfter ?? "?"}/${outcome.testTotalAfter ?? "?"} tests)`);
    if (!buildResult.passed) {
      throw new Error("Build verification failed. Hard reset performed.");
    }

    // Update planning status (best-effort)
    try {
      if (projectConfig && currentItem) {
        const succeeded = processed.improvementsSucceeded > 0;
        const newStatus = succeeded ? "Done" : "Up Next";
        updateItemStatus(projectConfig, currentItem.id, newStatus);
        console.log(`[planning] Updated "${currentItem.title}" → ${newStatus}`);
        commitRoadmap(cycleCount);
      }
    } catch (err) {
      console.error(`[planning] Failed to update roadmap status (non-fatal): ${(err as Error).message}`);
    }

    // Phase 3: Push
    console.log("\n========================================");
    console.log("  Phase 3: Push");
    console.log("========================================");
    outcome.pushSucceeded = false;
    if (pushChanges()) {
      console.log("[push] Changes pushed successfully.");
      outcome.pushSucceeded = true;
    } else {
      console.error("[push] Push failed. Changes remain local.");
    }
  } catch (err) {
    evolutionError = err as Error;
    console.error(`\n[error] Evolution failed: ${evolutionError.message}`);
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
