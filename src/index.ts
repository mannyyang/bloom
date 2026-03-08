import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";
import { initDb, getLatestCycleNumber, insertCycle, updateCycleOutcome, insertJournalEntry, insertPhaseUsage, getRecentJournalSummary, getCycleStats, formatCycleStats } from "./db.js";
import { fetchCommunityIssues, acknowledgeIssues, closeResolvedIssue, hasCommitForIssue } from "./issues.js";
import { buildAssessmentPrompt, buildEvolutionPrompt, parseEvolutionResult, countImprovements, extractResolvedIssueNumbers } from "./evolve.js";
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
import { createOutcome, formatOutcomeForJournal, parseTestCount } from "./outcomes.js";
import { extractLearnings, storeLearnings, storeStrategicContext, formatMemoryForPrompt } from "./memory.js";
import { ensureProject, getProjectItems, pickNextItem, updateItemStatus, formatPlanningContext, type ProjectConfig, type ProjectItem } from "./planning.js";

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
  console.log(`[preflight] PASSED in ${(preflightMs / 1000).toFixed(1)}s (${outcome.testCountBefore ?? "?"} tests)`);

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

    // Planning context (best-effort)
    let planningContext = "";
    let projectConfig: ProjectConfig | null = null;
    let currentItem: ProjectItem | null = null;
    try {
      console.log("[planning] Looking for GitHub Project board...");
      projectConfig = await ensureProject();
      if (projectConfig) {
        console.log(`[planning] Project found (id: ${projectConfig.projectId.slice(0, 20)}...)`);
        console.log(`[planning] Status field: ${projectConfig.statusFieldId.slice(0, 20)}...`);
        console.log(`[planning] Status columns: ${[...projectConfig.statusOptions.keys()].join(", ")}`);
        const projectItems = await getProjectItems(projectConfig);
        console.log(`[planning] ${projectItems.length} items on board`);
        for (const item of projectItems) {
          console.log(`  - [${item.status ?? "No Status"}] ${item.title}${item.reactions > 0 ? ` (${item.reactions} reactions)` : ""}`);
        }
        currentItem = pickNextItem(projectItems);
        if (currentItem) {
          console.log(`[planning] Selected: "${currentItem.title}" → marking In Progress`);
          await updateItemStatus(projectConfig, currentItem.id, "In Progress");
        } else {
          console.log("[planning] No actionable items found");
        }
        planningContext = formatPlanningContext(projectItems, currentItem);
      } else {
        console.log("[planning] No project board found (ensureProject returned null)");
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
      prompt: buildAssessmentPrompt({ identity, journalSummary, issues, cycleCount, cycleStatsText, memoryContext, planningContext }),
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

    // Acknowledge all community issues so contributors see their input was seen.
    console.log(`\n[issues] Acknowledging ${issues.length} community issues...`);
    await acknowledgeIssues(issues, cycleCount, db);
    console.log("[issues] Done.");

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

    // Parse journal sections from evolution result
    console.log("\n[journal] Parsing evolution result...");
    const journalSections = parseEvolutionResult(evolutionResult);
    for (const [section, content] of Object.entries(journalSections)) {
      if (content) {
        insertJournalEntry(db, cycleCount, section, content);
        console.log(`[journal] Stored section "${section}" (${content.length} chars)`);
      }
    }

    // Extract and store learnings (best-effort)
    try {
      const extracted = extractLearnings(journalSections.learnings);
      storeLearnings(db, cycleCount, extracted);
      console.log(`[memory] Stored ${extracted.learnings.length} learnings`);
    } catch {
      console.error("[memory] Failed to store learnings (non-fatal)");
    }

    // Extract and store strategic context (best-effort)
    try {
      const strategicCtx = journalSections.strategic_context;
      if (strategicCtx) {
        storeStrategicContext(db, cycleCount, strategicCtx);
        console.log(`[memory] Stored strategic context (${strategicCtx.length} chars)`);
      }
    } catch {
      console.error("[memory] Failed to store strategic context (non-fatal)");
    }

    // Populate improvement counts from parsed sections
    outcome.improvementsAttempted = countImprovements(journalSections.attempted);
    outcome.improvementsSucceeded = countImprovements(journalSections.succeeded);
    console.log(`[outcome] Improvements: ${outcome.improvementsSucceeded}/${outcome.improvementsAttempted} succeeded`);

    // Close issues mentioned in the succeeded section that have associated commits
    const openIssueNumbers = issues.map(i => i.number);
    const resolvedNumbers = extractResolvedIssueNumbers(journalSections.succeeded, openIssueNumbers);
    if (resolvedNumbers.length > 0) {
      console.log(`\n[issues] Found ${resolvedNumbers.length} potentially resolved issues: ${resolvedNumbers.map(n => `#${n}`).join(", ")}`);
    }
    for (const issueNum of resolvedNumbers) {
      if (hasCommitForIssue(issueNum)) {
        const issue = issues.find(i => i.number === issueNum);
        await closeResolvedIssue(issueNum, cycleCount, `Addressed: ${issue?.title ?? `issue #${issueNum}`}`, db);
        console.log(`[issues] Closed resolved issue #${issueNum}`);
      } else {
        console.log(`[issues] Skipping #${issueNum} — no commits found referencing it`);
      }
    }

    // Phase 2.5: Post-evolution build verification
    console.log("\n========================================");
    console.log("  Build Verification");
    console.log("========================================");
    const buildStart = Date.now();
    const buildResult = runBuildVerification(cycleCount);
    const buildMs = Date.now() - buildStart;
    outcome.buildVerificationPassed = buildResult.passed;
    outcome.testCountAfter = parseTestCount(buildResult.output);
    console.log(`[build] ${buildResult.passed ? "PASSED" : "FAILED"} in ${(buildMs / 1000).toFixed(1)}s (${outcome.testCountAfter ?? "?"} tests)`);
    if (!buildResult.passed) {
      throw new Error("Build verification failed. Hard reset performed.");
    }

    // Update planning status (best-effort)
    try {
      if (projectConfig && currentItem) {
        const succeeded = countImprovements(journalSections.succeeded) > 0;
        const newStatus = succeeded ? "Done" : "Up Next";
        await updateItemStatus(projectConfig, currentItem.id, newStatus);
        console.log(`[planning] Updated "${currentItem.title}" → ${newStatus}`);
      }
    } catch (err) {
      console.error(`[planning] Failed to update project status (non-fatal): ${(err as Error).message}`);
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
  console.log(`\n========================================`);
  console.log(`  Cycle ${cycleCount} — ${evolutionError ? "FAILED" : "COMPLETE"}`);
  console.log(`  Duration: ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  Improvements: ${outcome.improvementsSucceeded}/${outcome.improvementsAttempted}`);
  console.log(`  Tests: ${outcome.testCountBefore ?? "?"} → ${outcome.testCountAfter ?? "?"}`);
  console.log(`  Build: ${outcome.buildVerificationPassed ? "PASSED" : "FAILED"}`);
  console.log(`  Push: ${outcome.pushSucceeded ? "OK" : "FAILED"}`);
  console.log(`========================================\n`);
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
