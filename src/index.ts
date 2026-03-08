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
  const db = initDb();
  const cycleCount = getLatestCycleNumber(db) + 1;
  const outcome = createOutcome(cycleCount);
  console.log(`Bloom evolution cycle ${cycleCount}`);

  // Pre-flight check (before cycle row exists, safe to exit early)
  const preflight = runPreflightCheck();
  if (!preflight.passed) {
    console.error("Pre-flight check failed. Aborting evolution.");
    db.close();
    process.exit(1);
  }
  outcome.preflightPassed = true;
  outcome.testCountBefore = parseTestCount(preflight.output);

  setGitBotIdentity();

  // Insert cycle row (will be updated at end)
  insertCycle(db, outcome);
  commitDb(cycleCount, "start");

  // Create safety tag
  createSafetyTag(cycleCount);

  let evolutionError: Error | null = null;

  try {
    const identity = readFileSync("IDENTITY.md", "utf-8");
    const journalSummary = getRecentJournalSummary(db);
    const issues = await fetchCommunityIssues();
    const cycleStats = getCycleStats(db);
    const cycleStatsText = formatCycleStats(cycleStats);

    // Memory context (best-effort)
    const memoryContext = formatMemoryForPrompt(db, 2000);

    // Planning context (best-effort)
    let planningContext = "";
    let projectConfig: ProjectConfig | null = null;
    let currentItem: ProjectItem | null = null;
    try {
      projectConfig = await ensureProject();
      if (projectConfig) {
        const projectItems = await getProjectItems(projectConfig);
        currentItem = pickNextItem(projectItems);
        if (currentItem) {
          await updateItemStatus(projectConfig, currentItem.id, "In Progress");
        }
        planningContext = formatPlanningContext(projectItems, currentItem);
      }
    } catch {
      // Best-effort: don't let planning failures block evolution
    }

    // Phase 1: Assessment (read-only)
    console.log("\n--- Phase 1: Assessment ---");
    let assessment = "";
    const phaseUsages: PhaseUsage[] = [];
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
      if ("result" in msg) assessment = msg.result;
      const usage = extractUsage(msg as Record<string, unknown>, "Assessment");
      if (usage) {
        phaseUsages.push(usage);
        insertPhaseUsage(db, cycleCount, usage);
        console.log(formatPhaseUsage(usage));
      }
    }

    if (!assessment) {
      throw new Error("Assessment produced no output. Aborting.");
    }

    console.log("\nAssessment complete.");

    // Acknowledge all community issues so contributors see their input was seen.
    await acknowledgeIssues(issues, cycleCount, db);

    // Phase 2: Evolution (read-write with safety hooks)
    console.log("\n--- Phase 2: Evolution ---");
    const assessmentUsage = aggregateUsage(phaseUsages);
    const usageContext = formatUsageForJournal(assessmentUsage);
    const outcomeContext = formatOutcomeForJournal(outcome);
    let evolutionResult = "";
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

    // Log cycle usage summary
    const cycleUsage = aggregateUsage(phaseUsages);
    console.log("\n--- Usage Summary ---");
    console.log(formatCycleUsage(cycleUsage));

    // Parse journal sections from evolution result
    const journalSections = parseEvolutionResult(evolutionResult);
    for (const [section, content] of Object.entries(journalSections)) {
      if (content) {
        insertJournalEntry(db, cycleCount, section, content);
      }
    }

    // Extract and store learnings (best-effort)
    try {
      const extracted = extractLearnings(journalSections.learnings);
      storeLearnings(db, cycleCount, extracted);
    } catch {
      console.error("Failed to store learnings (non-fatal)");
    }

    // Extract and store strategic context (best-effort)
    try {
      const strategicCtx = journalSections.strategic_context;
      if (strategicCtx) {
        storeStrategicContext(db, cycleCount, strategicCtx);
      }
    } catch {
      console.error("Failed to store strategic context (non-fatal)");
    }

    // Populate improvement counts from parsed sections
    outcome.improvementsAttempted = countImprovements(journalSections.attempted);
    outcome.improvementsSucceeded = countImprovements(journalSections.succeeded);

    // Close issues mentioned in the succeeded section that have associated commits
    const openIssueNumbers = issues.map(i => i.number);
    const resolvedNumbers = extractResolvedIssueNumbers(journalSections.succeeded, openIssueNumbers);
    for (const issueNum of resolvedNumbers) {
      if (hasCommitForIssue(issueNum)) {
        const issue = issues.find(i => i.number === issueNum);
        await closeResolvedIssue(issueNum, cycleCount, `Addressed: ${issue?.title ?? `issue #${issueNum}`}`, db);
        console.log(`Closed resolved issue #${issueNum}`);
      } else {
        console.log(`Skipping issue #${issueNum} — no commits found referencing it`);
      }
    }

    // Phase 2.5: Post-evolution build verification
    console.log("\n--- Build Verification ---");
    const buildResult = runBuildVerification(cycleCount);
    outcome.buildVerificationPassed = buildResult.passed;
    outcome.testCountAfter = parseTestCount(buildResult.output);
    if (!buildResult.passed) {
      throw new Error("Build verification failed. Hard reset performed.");
    }

    // Update planning status (best-effort)
    try {
      if (projectConfig && currentItem) {
        const succeeded = countImprovements(journalSections.succeeded) > 0;
        if (succeeded) {
          await updateItemStatus(projectConfig, currentItem.id, "Done");
        } else {
          await updateItemStatus(projectConfig, currentItem.id, "Up Next");
        }
      }
    } catch {
      // Best-effort
    }

    // Phase 3: Push
    console.log("\n--- Phase 3: Push ---");
    outcome.pushSucceeded = false;
    if (pushChanges()) {
      console.log("Changes pushed successfully.");
      pushTags();
      outcome.pushSucceeded = true;
    } else {
      console.error("Push failed. Changes remain local.");
    }
  } catch (err) {
    evolutionError = err as Error;
    console.error("Evolution error:", evolutionError.message);
  } finally {
    // Always persist outcome and close DB, even on errors
    updateCycleOutcome(db, outcome);
    db.close();
  }

  // Always commit and push DB so failure metrics are not lost
  commitDb(cycleCount, "outcome");
  if (pushChanges()) {
    console.log("DB changes pushed successfully.");
  } else {
    console.error("DB push failed. Journal data remains local.");
  }
  pushTags();

  console.log("\n--- Outcome ---");
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
