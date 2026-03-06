import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";
import { incrementCycleCount } from "./utils.js";
import { fetchCommunityIssues, acknowledgeIssues } from "./issues.js";
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

async function main() {
  const cycleCount = incrementCycleCount();
  console.log(`Bloom evolution cycle ${cycleCount}`);

  // Pre-flight check
  if (!runPreflightCheck()) {
    console.error("Pre-flight check failed. Aborting evolution.");
    process.exit(1);
  }

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
  }

  if (!assessment) {
    console.error("Assessment produced no output. Aborting.");
    process.exit(1);
  }

  console.log("\nAssessment complete.");

  // Acknowledge all community issues so contributors see their input was seen.
  await acknowledgeIssues(issues, cycleCount);

  // Phase 2: Evolution (read-write with safety hooks)
  console.log("\n--- Phase 2: Evolution ---");
  for await (const msg of query({
    prompt: buildEvolutionPrompt(assessment),
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
  }

  // Phase 2.5: Post-evolution build verification
  console.log("\n--- Build Verification ---");
  try {
    runBuildVerification(cycleCount);
  } catch {
    console.error("Revert failed. Manual intervention needed.");
    process.exit(1);
  }

  // Phase 3: Push
  console.log("\n--- Phase 3: Push ---");
  if (pushChanges()) {
    console.log("Changes pushed successfully.");
    pushTags();
  } else {
    console.error("Push failed. Changes remain local.");
  }
}

main().catch((err) => {
  console.error("Evolution failed:", err);
  process.exit(1);
});
