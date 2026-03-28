/**
 * Standalone assessment CLI — runs only the assessment phase in read-only mode
 * and prints the result. Does not commit, push, or modify any state.
 *
 * Useful for auditing what Bloom is planning and debugging prompt quality
 * without triggering a full evolution cycle.
 *
 * Usage: pnpm assess
 */
import { readFileSync } from "fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  initDb,
  getLatestCycleNumber,
  getRecentJournalSummary,
  getCycleStats,
  formatCycleStats,
} from "./db.js";
import { buildAssessmentPrompt } from "./evolve.js";
import { errorMessage } from "./errors.js";
import { formatMemoryForPrompt } from "./memory.js";
import {
  ensureProject,
  getProjectItems,
  formatPlanningContext,
} from "./planning.js";
import { extractResultText, formatDurationSec } from "./usage.js";
import { resolveModel } from "./agent-phases.js";

async function main() {
  const startTime = Date.now();
  console.log("\n========================================");
  console.log("  Bloom Assessment (read-only)");
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log("========================================\n");

  // Load context from DB (read-only — no insertions or mutations)
  const db = initDb();
  const cycleCount = getLatestCycleNumber(db) + 1;

  const identity = readFileSync("IDENTITY.md", "utf-8");
  const journalSummary = getRecentJournalSummary(db, 1200, 2);
  const cycleStats = getCycleStats(db);
  const cycleStatsText = formatCycleStats(cycleStats);
  const memoryContext = formatMemoryForPrompt(db, 1200);

  console.log(`[assess] Cycle: ${cycleCount}`);
  console.log(`[assess] Journal: ${journalSummary ? `${journalSummary.length} chars` : "empty"}`);
  console.log(`[assess] Memory: ${memoryContext ? `${memoryContext.length} chars` : "empty"}`);

  // Load planning context read-only — skip triage and status mutations
  let planningContext = "";
  try {
    const projectConfig = ensureProject();
    const projectItems = getProjectItems(projectConfig);
    planningContext = formatPlanningContext(projectItems, null);
    console.log(`[assess] Roadmap items: ${projectItems.length}`);
  } catch (err) {
    console.error(`[assess] Planning context unavailable (non-fatal): ${errorMessage(err)}`);
  }

  db.close();

  const prompt = buildAssessmentPrompt({
    journalSummary,
    cycleCount,
    cycleStatsText,
    memoryContext,
    planningContext,
  });

  console.log("\n[assess] Querying LLM...\n");

  let assessment = "";
  let turns = 0;

  for await (const msg of query({
    prompt,
    options: {
      cwd: process.cwd(),
      model: resolveModel(),
      allowedTools: ["Read", "Glob", "Grep", "Bash"],
      permissionMode: "dontAsk",
      systemPrompt: identity,
      maxTurns: 20,
      maxBudgetUsd: 2.0,
    },
  })) {
    turns++;
    const resultText = extractResultText(msg);
    if (resultText !== null) {
      assessment = resultText;
    }
  }

  const durationMs = Date.now() - startTime;
  console.log(`\n[assess] Completed in ${formatDurationSec(durationMs)} (${turns} turns)\n`);
  console.log("========================================");
  console.log("  Assessment Result");
  console.log("========================================\n");
  console.log(assessment || "(no output produced)");
}

main().catch((err) => {
  console.error("Assessment failed:", errorMessage(err));
  process.exit(1);
});
