/**
 * Orchestration phase helpers for the Bloom evolution cycle.
 * Extracted from index.ts for testability.
 */
import {
  runBuildVerification,
  pushChanges,
  commitRoadmap,
} from "./lifecycle.js";
import { parseTestCount, parseTestTotal, recordBuildFailure } from "./outcomes.js";
import { errorMessage } from "./errors.js";
import { formatDurationSec } from "./usage.js";
import { updateItemStatus, STATUS_UP_NEXT, STATUS_DONE, type ProjectConfig, type ProjectItem } from "./planning.js";
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
    recordBuildFailure(outcome, buildResult.output);
    throw new Error("Build verification failed. Hard reset performed.");
  }
}

/**
 * Update the roadmap planning status based on evolution results (best-effort).
 *
 * Determines the new status for the current roadmap item and, if the status
 * changes, commits the updated ROADMAP.md and optionally closes a linked
 * GitHub issue.  Any error thrown during this process is caught and logged so
 * the overall cycle can still complete.
 *
 * ## Status promotion logic
 *
 * The item is promoted to "Done" **only** when **both** of the following are
 * true:
 *   (a) `processed.improvementsSucceeded > 0` — at least one improvement
 *       actually landed in this cycle; and
 *   (b) if `currentItem.linkedIssueNumber` is set, the stringified issue
 *       number appears in `processed.succeededSummary` (using word-boundary
 *       anchors so "#4123" does not spuriously match issue #123).
 *
 * If either condition fails the item status is set to "Up Next" instead,
 * and a `console.warn` is emitted explaining why the promotion was skipped.
 *
 * ## Side-effects on status change
 *
 * When `updateItemStatus` returns `true` (item found and updated):
 *   1. `commitRoadmap(cycleCount)` is called to persist the updated
 *      ROADMAP.md to git on any status change (Done *or* Up Next).
 *   2. If the new status is "Done" **and** `linkedIssueNumber` is not null,
 *      `closeIssueWithComment` is called to close the GitHub issue and post a
 *      completion comment as proof of resolution.
 *
 * If `updateItemStatus` returns `false` (item ID not found in the roadmap)
 * the roadmap commit and issue-close are both skipped and an error is logged.
 *
 * ## Best-effort semantics
 *
 * The entire function body is wrapped in a `try/catch`.  Errors from any of
 * the steps above (roadmap commit, issue API call, etc.) are caught and
 * logged via `console.error` but are **not** re-thrown, so the caller
 * (the evolution cycle) continues regardless.
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
        // Lookahead/lookbehind anchors prevent partial-number matches (e.g. "4123" ≠ "123").
        const issuePattern = new RegExp(`(?<![0-9])${n}(?![0-9])`);
        const mentionsIssue = issuePattern.test(summary);
        if (!mentionsIssue) {
          console.warn(
            `[planning] Issue #${n} not mentioned in succeeded summary — keeping "${currentItem.title}" as "Up Next"`,
          );
          succeeded = false;
        }
      }
      const newStatus = succeeded ? STATUS_DONE : STATUS_UP_NEXT;
      const completionNote = succeeded
        ? `Completed in cycle ${cycleCount}: ${processed.improvementsSucceeded}/${processed.improvementsAttempted} improvements succeeded.`
        : undefined;
      const updated = updateItemStatus(projectConfig, currentItem.id, newStatus, completionNote);
      if (updated) {
        console.log(`[planning] Updated "${currentItem.title}" → ${newStatus}`);
        commitRoadmap(cycleCount);
        // Close the linked GitHub issue now that work is confirmed Done, providing
        // proof of resolution rather than closing prematurely at triage time.
        if (newStatus === STATUS_DONE && n !== null) {
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
    } else {
      console.log("[planning] No roadmap config or current item — skipping status update");
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
