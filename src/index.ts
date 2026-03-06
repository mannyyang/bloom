import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";
import { incrementCycleCount } from "./utils.js";
import { fetchCommunityIssues, acknowledgeIssues, closeResolvedIssue, ResolvedIssue } from "./issues.js";
import { buildAssessmentPrompt, buildEvolutionPrompt } from "./evolve.js";
import {
  protectIdentity,
  enforceAppendOnly,
  blockDangerousCommands,
} from "./safety.js";
import {
  runPreflightCheck,
  setGitBotIdentity,
  commitCycleCount,
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
import { createOutcome, formatOutcomeForJournal, persistOutcome } from "./outcomes.js";

async function main() {
  const cycleCount = incrementCycleCount();
  const outcome = createOutcome(cycleCount);
  console.log(`Bloom evolution cycle ${cycleCount}`);

  // Pre-flight check
  if (!runPreflightCheck()) {
    console.error("Pre-flight check failed. Aborting evolution.");
    process.exit(1);
  }
  outcome.preflightPassed = true;

  setGitBotIdentity();

  // Commit the updated cycle count
  commitCycleCount(cycleCount);

  // Create safety tag
  createSafetyTag(cycleCount);

  const identity = readFileSync("IDENTITY.md", "utf-8");
  const journal = readFileSync("JOURNAL.md", "utf-8");
  const issues = await fetchCommunityIssues();

  // Phase 1: Assessment (read-only)
  console.log("\n--- Phase 1: Assessment ---");
  let assessment = "";
  const phaseUsages: PhaseUsage[] = [];
  for await (const msg of query({
    prompt: buildAssessmentPrompt({ identity, journal, issues, cycleCount }),
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
      console.log(formatPhaseUsage(usage));
    }
  }

  if (!assessment) {
    console.error("Assessment produced no output. Aborting.");
    process.exit(1);
  }

  console.log("\nAssessment complete.");

  // Acknowledge all community issues so contributors see their input was seen.
  await acknowledgeIssues(issues, cycleCount);

  // Close resolved community issues (community issue #5).
  const resolvedIssues: ResolvedIssue[] = [
    { issueNumber: 3, reason: "Success metrics implemented in cycles 46-47 via `outcomes.ts`." },
    { issueNumber: 4, reason: "Token/cost tracking implemented in cycle 45 via `usage.ts`." },
    { issueNumber: 5, reason: "Auto-closing of resolved issues implemented in cycle 48 via `closeResolvedIssue()`." },
    { issueNumber: 6, reason: "Metrics persistence implemented in cycle 47 via `METRICS.json` and `persistOutcome()`." },
    { issueNumber: 7, reason: "Test review completed in cycle 48. All 517 tests are necessary — safety tests are extensive by design." },
  ];
  for (const ri of resolvedIssues) {
    await closeResolvedIssue(ri.issueNumber, cycleCount, ri.reason);
  }

  // Phase 2: Evolution (read-write with safety hooks)
  console.log("\n--- Phase 2: Evolution ---");
  const assessmentUsage = aggregateUsage(phaseUsages);
  const usageContext = formatUsageForJournal(assessmentUsage);
  const outcomeContext = formatOutcomeForJournal(outcome);
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
          { matcher: "Write|Edit", hooks: [protectIdentity] },
          { matcher: "Write|Edit", hooks: [enforceAppendOnly] },
          { matcher: "Bash", hooks: [blockDangerousCommands] },
        ],
      },
    },
  })) {
    if ("result" in msg) console.log(msg.result);
    const usage = extractUsage(msg as Record<string, unknown>, "Evolution");
    if (usage) {
      phaseUsages.push(usage);
      console.log(formatPhaseUsage(usage));
    }
  }

  // Log cycle usage summary
  const cycleUsage = aggregateUsage(phaseUsages);
  console.log("\n--- Usage Summary ---");
  console.log(formatCycleUsage(cycleUsage));

  // Phase 2.5: Post-evolution build verification
  console.log("\n--- Build Verification ---");
  try {
    const buildPassed = runBuildVerification(cycleCount);
    outcome.buildVerificationPassed = buildPassed;
    if (!buildPassed) {
      console.error("Build verification failed. Hard reset performed.");
      process.exit(1);
    }
  } catch {
    console.error("Revert failed. Manual intervention needed.");
    process.exit(1);
  }

  // Phase 3: Push
  console.log("\n--- Phase 3: Push ---");
  if (pushChanges()) {
    console.log("Changes pushed successfully.");
    pushTags();
    outcome.pushSucceeded = true;
  } else {
    console.error("Push failed. Changes remain local.");
  }

  // Persist and log final outcome
  persistOutcome(outcome);
  console.log("\n--- Outcome ---");
  console.log(formatOutcomeForJournal(outcome));
}

main().catch((err) => {
  console.error("Evolution failed:", err);
  process.exit(1);
});
