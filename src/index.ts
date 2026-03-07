import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";
import { initDb, getLatestCycleNumber, insertCycle, insertJournalEntry, insertPhaseUsage, getRecentJournalSummary } from "./db.js";
import { fetchCommunityIssues, acknowledgeIssues } from "./issues.js";
import { buildAssessmentPrompt, buildEvolutionPrompt, parseEvolutionResult, countImprovements } from "./evolve.js";
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

async function main() {
  const db = initDb();
  const cycleCount = getLatestCycleNumber(db) + 1;
  const outcome = createOutcome(cycleCount);
  console.log(`Bloom evolution cycle ${cycleCount}`);

  // Pre-flight check
  const preflight = runPreflightCheck();
  if (!preflight.passed) {
    console.error("Pre-flight check failed. Aborting evolution.");
    process.exit(1);
  }
  outcome.preflightPassed = true;
  outcome.testCountBefore = parseTestCount(preflight.output);

  setGitBotIdentity();

  // Insert cycle row (will be updated at end)
  insertCycle(db, outcome);
  commitDb(cycleCount);

  // Create safety tag
  createSafetyTag(cycleCount);

  const identity = readFileSync("IDENTITY.md", "utf-8");
  const journalSummary = getRecentJournalSummary(db);
  const issues = await fetchCommunityIssues();

  // Phase 1: Assessment (read-only)
  console.log("\n--- Phase 1: Assessment ---");
  let assessment = "";
  const phaseUsages: PhaseUsage[] = [];
  for await (const msg of query({
    prompt: buildAssessmentPrompt({ identity, journalSummary, issues, cycleCount }),
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
    console.error("Assessment produced no output. Aborting.");
    process.exit(1);
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

  // Populate improvement counts from parsed sections
  outcome.improvementsAttempted = countImprovements(journalSections.attempted);
  outcome.improvementsSucceeded = countImprovements(journalSections.succeeded);

  // Note: resolved issues are now closed dynamically by the evolution agent
  // using closeResolvedIssue() with db-backed idempotency (no more hardcoded list).

  // Phase 2.5: Post-evolution build verification
  console.log("\n--- Build Verification ---");
  try {
    const buildResult = runBuildVerification(cycleCount);
    outcome.buildVerificationPassed = buildResult.passed;
    outcome.testCountAfter = parseTestCount(buildResult.output);
    if (!buildResult.passed) {
      console.error("Build verification failed. Hard reset performed.");
      process.exit(1);
    }
  } catch {
    console.error("Revert failed. Manual intervention needed.");
    process.exit(1);
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

  // Update cycle row with final outcome
  insertCycle(db, outcome);
  db.close();

  // Commit updated DB and push
  commitDb(cycleCount);
  if (!outcome.pushSucceeded) {
    // Try push again with updated DB
    if (pushChanges()) {
      console.log("DB changes pushed successfully.");
      pushTags();
    }
  }

  console.log("\n--- Outcome ---");
  console.log(formatOutcomeForJournal(outcome));
}

main().catch((err) => {
  console.error("Evolution failed:", err);
  process.exit(1);
});
