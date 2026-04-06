/**
 * Agent phase runners extracted from index.ts for testability.
 * Uses dependency injection for the SDK query function so phases
 * can be unit tested with mock async generators.
 */
import type Database from "better-sqlite3";
import { buildAssessmentPrompt, buildEvolutionPrompt } from "./evolve.js";
import {
  extractUsage,
  extractResultText,
  aggregateUsage,
  formatPhaseUsage,
  formatCycleUsage,
  formatUsageForJournal,
  formatDurationSec,
  type PhaseUsage,
} from "./usage.js";
import { formatOutcomeForJournal } from "./outcomes.js";
import { errorMessage } from "./errors.js";
import { processEvolutionResult, type ProcessedEvolution } from "./orchestrator.js";
import { insertPhaseUsage } from "./db.js";
import type { EvolutionContext } from "./context.js";
import type { CycleOutcome } from "./outcomes.js";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

/** The default Claude model used when BLOOM_MODEL env var is not set. */
export const DEFAULT_BLOOM_MODEL = "claude-sonnet-4-6";

/**
 * Resolve the model to use for LLM calls.
 * Reads BLOOM_MODEL at call time so tests can override it via process.env.
 */
export function resolveModel(): string {
  return process.env.BLOOM_MODEL ?? DEFAULT_BLOOM_MODEL;
}

/**
 * Type for the SDK query function. Accepts prompt + options and returns
 * an async iterable of opaque messages. Using `unknown` for messages
 * since we parse them via extractUsage() which handles validation.
 */
export type QueryFn = (params: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<unknown>;

/**
 * Dependencies injected into phase runners for testability.
 */
export interface PhaseDeps {
  queryFn: QueryFn;
  insertPhaseUsage: (db: Database.Database, cycleNumber: number, usage: PhaseUsage) => void;
  processEvolutionResult: (db: Database.Database, cycleCount: number, evolutionResult: string) => ProcessedEvolution;
}

/**
 * Create default dependencies using real implementations.
 */
export function createDefaultDeps(queryFn: QueryFn): PhaseDeps {
  return {
    queryFn,
    insertPhaseUsage,
    processEvolutionResult,
  };
}

/**
 * Run the read-only assessment phase using the Claude agent.
 * Returns the assessment text and populates phaseUsages.
 */
export async function runAssessmentPhase(
  db: Database.Database,
  cycleCount: number,
  ctx: EvolutionContext,
  phaseUsages: PhaseUsage[],
  deps: PhaseDeps,
): Promise<string> {
  console.log("\n========================================");
  console.log("  Phase 1: Assessment (read-only)");
  console.log("========================================");
  const assessmentStart = Date.now();
  let assessment = "";
  let assessmentTurns = 0;
  for await (const msg of deps.queryFn({
    prompt: buildAssessmentPrompt({
      journalSummary: ctx.journalSummary,
      cycleCount,
      cycleStatsText: ctx.cycleStatsText,
      memoryContext: ctx.memoryContext,
      planningContext: ctx.planningContext,
    }),
    options: {
      cwd: process.cwd(),
      model: resolveModel(),
      allowedTools: ["Read", "Glob", "Grep", "Bash"],
      permissionMode: "dontAsk",
      systemPrompt: ctx.identity,
      maxTurns: 20,
      maxBudgetUsd: 2.0,
    },
  })) {
    assessmentTurns++;
    const resultText = extractResultText(msg);
    if (resultText !== null) {
      assessment = resultText;
    }
    const usage = extractUsage(msg, "Assessment");
    if (usage) {
      phaseUsages.push(usage);
      deps.insertPhaseUsage(db, cycleCount, usage);
      console.log(formatPhaseUsage(usage));
    }
  }
  const assessmentMs = Date.now() - assessmentStart;

  if (!assessment) {
    if (assessmentTurns === 0) {
      throw new Error("Assessment produced no output (0 turns). Aborting.");
    }
    // Turns ran but yielded no text content blocks — use a minimal fallback
    // so the evolution phase can still run rather than wasting the cycle.
    console.warn(
      `[assessment] Warning: ${assessmentTurns} turn(s) completed but produced no text output. Using fallback assessment.`,
    );
    assessment = `(The assessment phase completed ${assessmentTurns} turn(s) but produced no readable text output. Please review the codebase independently and suggest small, safe improvements.)`;
  }

  console.log(`\n[assessment] Completed in ${formatDurationSec(assessmentMs)} (${assessmentTurns} turns, ${assessment.length} chars)`);
  console.log(`[assessment] Output preview:\n${assessment.slice(0, 500)}${assessment.length > 500 ? "\n  ..." : ""}`);

  return assessment;
}

/** Safety hooks used by the evolution phase. */
export interface SafetyHooks {
  protectIdentity: HookCallback;
  protectJournal: HookCallback;
  blockDangerousCommands: HookCallback;
}

/**
 * Run the read-write evolution phase using the Claude agent.
 * Processes the result (journal, learnings, strategic context) and updates outcome.
 */
export async function runEvolutionPhase(
  db: Database.Database,
  cycleCount: number,
  outcome: CycleOutcome,
  assessment: string,
  identity: string,
  phaseUsages: PhaseUsage[],
  deps: PhaseDeps,
  safetyHooks: SafetyHooks,
): Promise<ProcessedEvolution> {
  console.log("\n========================================");
  console.log("  Phase 2: Evolution (read-write)");
  console.log("========================================");
  const evolutionStart = Date.now();
  const assessmentUsage = aggregateUsage(phaseUsages);
  const usageContext = formatUsageForJournal(assessmentUsage);
  const outcomeContext = formatOutcomeForJournal(outcome);
  let evolutionResult = "";
  let evolutionTurns = 0;
  for await (const msg of deps.queryFn({
    prompt: buildEvolutionPrompt(assessment, { usageContext, outcomeContext }),
    options: {
      cwd: process.cwd(),
      model: resolveModel(),
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      permissionMode: "acceptEdits",
      systemPrompt: identity,
      maxTurns: 50,
      maxBudgetUsd: 5.0,
      hooks: {
        PreToolUse: [
          { matcher: "Write|Edit", hooks: [safetyHooks.protectIdentity, safetyHooks.protectJournal] },
          { matcher: "Bash", hooks: [safetyHooks.blockDangerousCommands] },
        ],
      },
    },
  })) {
    evolutionTurns++;
    const resultText = extractResultText(msg);
    if (resultText !== null) {
      evolutionResult = resultText;
      console.log(resultText);
    }
    const usage = extractUsage(msg, "Evolution");
    if (usage) {
      phaseUsages.push(usage);
      deps.insertPhaseUsage(db, cycleCount, usage);
      console.log(formatPhaseUsage(usage));
    }
  }
  const evolutionMs = Date.now() - evolutionStart;
  console.log(`\n[evolution] Completed in ${formatDurationSec(evolutionMs)} (${evolutionTurns} turns)`);

  // Log cycle usage summary
  const cycleUsage = aggregateUsage(phaseUsages);
  console.log("\n[usage] Cycle usage summary:");
  console.log(formatCycleUsage(cycleUsage));

  // Process evolution result: parse journal, store learnings, close resolved issues
  console.log("\n[journal] Processing evolution result...");
  let processed: ProcessedEvolution;
  try {
    processed = deps.processEvolutionResult(db, cycleCount, evolutionResult);
  } catch (err) {
    console.error(`[journal] processEvolutionResult failed (non-fatal): ${errorMessage(err)}`);
    console.error(`[journal] Continuing with partial data — journal/learnings may be incomplete for this cycle.`);
    // Return a minimal ProcessedEvolution so the caller can continue
    return {
      journalSections: { attempted: "", succeeded: "", failed: "", learnings: "", strategic_context: "" },
      succeededSummary: "",
      learningsStored: 0,
      strategicContextStored: false,
      improvementsAttempted: outcome.improvementsAttempted,
      improvementsSucceeded: outcome.improvementsSucceeded,
    };
  }
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
