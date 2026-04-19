/**
 * Orchestration phase helpers for the Bloom evolution cycle.
 * Extracted from index.ts for testability.
 */
import {
  runBuildVerification,
  pushChanges,
  commitRoadmap,
} from "./lifecycle.js";
import { parseTestCount, parseTestTotal, classifyBuildFailure } from "./outcomes.js";
import { errorMessage } from "./errors.js";
import { formatDurationSec } from "./usage.js";
import { updateItemStatus, demoteStaleInProgressItems, type ProjectConfig, type ProjectItem } from "./planning.js";
import type { CycleOutcome } from "./outcomes.js";
import { closeIssueWithComment } from "./issues.js";
import type Database from "better-sqlite3";

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
  console.log(`[build] ${buildResult.passed ? "PASSED" : "FAILED"} in ${formatDurationSec(buildMs)} (${outcome.testCountAfter ?? "?"}/${outcome.testTotalAfter ?? "?"} tests)`);
  if (!buildResult.passed) {
    outcome.failureCategory = classifyBuildFailure(buildResult.output);
    throw new Error("Build verification failed. Hard reset performed.");
  }
}

/**
 * Update the roadmap planning status based on evolution results (best-effort).
 * When an item transitions to "Done" and has a linked GitHub issue, the issue
 * is closed with a completion comment as proof of resolution.
 */
export async function updatePlanningStatus(
  cycleCount: number,
  projectConfig: ProjectConfig | null,
  currentItem: ProjectItem | null,
  processed: { improvementsSucceeded: number; improvementsAttempted: number; succeededSummary?: string },
  db?: Database.Database,
): Promise<void> {
  try {
    if (projectConfig && currentItem) {
      const n = currentItem.linkedIssueNumber;
      let succeeded = processed.improvementsSucceeded > 0;
      // Guard against spurious Done-promotion: if the item is linked to a specific
      // issue, verify the issue number appears in the succeeded summary.  This
      // catches cycles where the LLM reports improvements but worked on something
      // unrelated to the linked issue.
      if (succeeded && n !== null) {
        const summary = processed.succeededSummary ?? "";
        // The lookaround anchors ensure e.g. "123" does not match inside "4123".
        // `mentionsIssue` is already false when summary is empty (regex returns false on ""),
        // so a separate `!summary` guard is redundant and misleading — drop it.
        const issuePattern = new RegExp(`(?<![0-9])${n}(?![0-9])`);
        const mentionsIssue = issuePattern.test(summary);
        if (!mentionsIssue) {
          console.warn(
            `[planning] Issue #${n} not mentioned in succeeded summary — keeping "${currentItem.title}" as "Up Next"`,
          );
          succeeded = false;
        }
      }
      const newStatus = succeeded ? "Done" : "Up Next";
      const completionNote = succeeded
        ? `Completed in cycle ${cycleCount}: ${processed.improvementsSucceeded}/${processed.improvementsAttempted} improvements succeeded.`
        : undefined;
      const updated = updateItemStatus(projectConfig, currentItem.id, newStatus, completionNote);
      if (updated) {
        console.log(`[planning] Updated "${currentItem.title}" → ${newStatus}`);
        commitRoadmap(cycleCount);
        // Close the linked GitHub issue now that work is confirmed Done, providing
        // proof of resolution rather than closing prematurely at triage time.
        if (newStatus === "Done" && n !== null) {
          const closeComment = `${completionNote}\n\nThis issue has been resolved — the linked roadmap item is now marked Done.`;
          await closeIssueWithComment(
            n,
            cycleCount,
            closeComment,
            db,
            "completed",
          );
        }
      } else {
        console.error(`[planning] Item "${currentItem.title}" (id=${currentItem.id}) not found in roadmap — skipping commit.`);
      }
    }
  } catch (err) {
    console.error(`[planning] Failed to update roadmap status (non-fatal): ${errorMessage(err)}`);
  }
}

/** Number of cycles an item can remain In Progress before being demoted back to Up Next. */
export const DEMOTE_STALE_THRESHOLD = 3;

/**
 * Demote any In Progress items stuck beyond the staleness threshold back to Up Next.
 * Should be called before assessment so item selection reflects the corrected state.
 */
export function demoteStaleItemsPhase(
  projectConfig: ProjectConfig | null,
  cycleCount: number,
  threshold: number = DEMOTE_STALE_THRESHOLD,
): void {
  if (!projectConfig) return;
  const demoted = demoteStaleInProgressItems(projectConfig, cycleCount, threshold);
  if (demoted.length > 0) {
    console.log(
      `[planning] Demoted ${demoted.length} stale In Progress item(s) back to Up Next: ${demoted.join(", ")}`,
    );
  }
}

/**
 * Push changes and tags to the remote repository.
 */
export function pushChangesPhase(outcome: CycleOutcome): void {
  console.log("\n========================================");
  console.log("  Push");
  console.log("========================================");
  outcome.pushSucceeded = false;
  if (pushChanges()) {
    console.log("[push] Changes pushed successfully.");
    outcome.pushSucceeded = true;
  } else {
    console.error("[push] Push failed. Changes remain local.");
  }
}
