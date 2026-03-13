/**
 * Orchestration phase helpers for the Bloom evolution cycle.
 * Extracted from index.ts for testability.
 */
import {
  runBuildVerification,
  pushChanges,
  commitRoadmap,
} from "./lifecycle.js";
import { parseTestCount, parseTestTotal } from "./outcomes.js";
import { errorMessage } from "./errors.js";
import { updateItemStatus, type ProjectConfig, type ProjectItem } from "./planning.js";
import type { CycleOutcome } from "./outcomes.js";

/**
 * Run post-evolution build verification. Throws if verification fails.
 */
export function runBuildVerificationPhase(
  cycleCount: number,
  outcome: CycleOutcome,
): void {
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
}

/**
 * Update the roadmap planning status based on evolution results (best-effort).
 */
export function updatePlanningStatus(
  cycleCount: number,
  projectConfig: ProjectConfig | null,
  currentItem: ProjectItem | null,
  processed: { improvementsSucceeded: number; improvementsAttempted: number },
): void {
  try {
    if (projectConfig && currentItem) {
      const succeeded = processed.improvementsSucceeded > 0;
      const newStatus = succeeded ? "Done" : "Up Next";
      const completionNote = succeeded
        ? `Completed in cycle ${cycleCount}: ${processed.improvementsSucceeded}/${processed.improvementsAttempted} improvements succeeded.`
        : undefined;
      updateItemStatus(projectConfig, currentItem.id, newStatus, completionNote);
      console.log(`[planning] Updated "${currentItem.title}" → ${newStatus}`);
      commitRoadmap(cycleCount);
    }
  } catch (err) {
    console.error(`[planning] Failed to update roadmap status (non-fatal): ${errorMessage(err)}`);
  }
}

/**
 * Push changes and tags to the remote repository.
 */
export function pushChangesPhase(outcome: CycleOutcome): void {
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
}
