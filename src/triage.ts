import type Database from "better-sqlite3";
import { type CommunityIssue, closeIssueWithComment, detectRepo, isValidRepo } from "./issues.js";
import { hasIssueAction, insertIssueAction } from "./db.js";
import { errorMessage } from "./errors.js";
import { addLinkedItem, type ProjectConfig, type ProjectItem } from "./planning.js";
import { type QueryFn, resolveModel } from "./agent-phases.js";
import { extractResultText } from "./usage.js";

// Prompt-preview cap for issue bodies — keeps prompts concise without
// affecting stored content (cf. ITEM_BODY_LIMIT in planning.ts which is 500).
export const PROMPT_BODY_PREVIEW_CHARS = 200;

/** Maximum LLM turns allowed per triage call. */
export const TRIAGE_MAX_TURNS = 3;

/** Maximum USD budget per triage LLM call. */
export const TRIAGE_MAX_BUDGET_USD = 0.5;

/** Maximum character length accepted for a triage decision reason string. */
export const TRIAGE_REASON_MAX_CHARS = 2000;

/** Number of chars of a failed-parse JSON string shown in the warning log. */
export const TRIAGE_ERROR_PREVIEW_CHARS = 200;

/** Action name recorded in issue_actions to mark an issue as triaged.
 *  Used for deduplication — every path that processes an issue must write
 *  exactly this string so hasIssueAction guards fire correctly. */
export const TRIAGE_ACTION_NAME = "triaged";

/** Board status string that signals a roadmap item is complete.
 *  Gates issue-closing logic: issues are only closed when their linked
 *  board item carries exactly this status (case-sensitive). */
export const TRIAGE_BOARD_STATUS_DONE = "Done";

/** Comment posted when closing an issue that is already tracked on the
 *  Bloom Evolution Roadmap board. */
export const TRIAGE_ALREADY_ON_BOARD_COMMENT = "This issue is already tracked on the Bloom Evolution Roadmap.";

// --- Types ---

export interface TriageDecision {
  issueNumber: number;
  action: "add_to_backlog" | "already_done" | "not_applicable";
  reason: string;
}

export interface TriageResult {
  decisions: TriageDecision[];
  addedToBacklog: number[];
  closed: number[];
}

// --- Prompt Building ---

export function buildTriagePrompt(
  issues: CommunityIssue[],
  boardItems: ProjectItem[],
): string {
  const issueList = issues
    .map(
      (i) =>
        `- #${i.number}: "${i.title}" (${i.reactions} reactions)\n  ${i.body.slice(0, PROMPT_BODY_PREVIEW_CHARS)}`,
    )
    .join("\n");

  const boardList =
    boardItems.length > 0
      ? boardItems
          .map(
            (item) =>
              `- [${item.status ?? "No Status"}] ${item.title}${item.linkedIssueNumber ? ` (#${item.linkedIssueNumber})` : ""}`,
          )
          .join("\n")
      : "No items on board yet.";

  return `You are Bloom, a self-evolving coding agent. You need to triage new community issues.

For each issue below, decide one of:
- "add_to_backlog": Valid work request — add to the roadmap backlog for future cycles.
- "already_done": This is already explicitly tracked on the roadmap board above.
- "not_applicable": Not relevant, not actionable, or out of scope.

## New issues to triage:
${issueList}

## Current roadmap state:
${boardList}

Respond with ONLY a JSON array of objects. No other text. Example:
[{"issueNumber": 1, "action": "add_to_backlog", "reason": "Valid feature request for improving error messages."}]`;
}

// --- Response Parsing ---

export function parseTriageResponse(text: string): TriageDecision[] {
  // Extract JSON from potentially fenced markdown
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = fenceMatch ? fenceMatch[1] : text.trim();

  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) {
      console.warn(`[triage] parseTriageResponse: expected JSON array but got ${typeof parsed}, returning empty decisions.`);
      return [];
    }

    const validDecisions = parsed.filter(
      (item): item is TriageDecision =>
        typeof item === "object" &&
        item !== null &&
        typeof item.issueNumber === "number" &&
        ["add_to_backlog", "already_done", "not_applicable"].includes(
          item.action,
        ) &&
        typeof item.reason === "string" &&
        item.reason.length > 0 &&
        item.reason.length <= TRIAGE_REASON_MAX_CHARS,
    );
    const droppedCount = parsed.length - validDecisions.length;
    if (droppedCount > 0) {
      console.warn(`[triage] parseTriageResponse: dropped ${droppedCount} item(s) with unrecognised action or missing fields (prompt drift?)`);
    }
    return validDecisions;
  } catch {
    console.warn(`[triage] parseTriageResponse: failed to parse JSON, returning empty decisions. Input (first ${TRIAGE_ERROR_PREVIEW_CHARS} chars): ${jsonStr.slice(0, TRIAGE_ERROR_PREVIEW_CHARS)}`);
    return [];
  }
}

// --- Dependency Injection ---

export interface TriageDeps {
  queryFn: QueryFn;
}

// --- Main Triage Function ---

export async function triageIssues(
  issues: CommunityIssue[],
  boardItems: ProjectItem[],
  cycleCount: number,
  projectConfig: ProjectConfig,
  db?: Database.Database,
  deps?: TriageDeps,
): Promise<TriageResult> {
  const result: TriageResult = {
    decisions: [],
    addedToBacklog: [],
    closed: [],
  };

  if (issues.length === 0) return result;

  // Detect repo once upfront to avoid redundant subprocess calls per issue
  const repo = detectRepo();

  // Filter out issues already on the board (by linkedIssueNumber)
  const boardIssueNumbers = new Set(
    boardItems
      .map((item) => item.linkedIssueNumber)
      .filter((n): n is number => n !== null),
  );

  // Close issues already on the board only when the linked item is Done —
  // work must be confirmed complete before closing the community issue.
  // Run all close API calls concurrently to eliminate linear latency scaling.
  const alreadyOnBoard = issues.filter((i) => boardIssueNumbers.has(i.number));
  const closeCandidates = alreadyOnBoard.filter((issue) => {
    const linkedItem = boardItems.find((item) => item.linkedIssueNumber === issue.number);
    if (!linkedItem || linkedItem.status !== TRIAGE_BOARD_STATUS_DONE) return false;
    if (db && hasIssueAction(db, issue.number, TRIAGE_ACTION_NAME)) return false;
    return true;
  });

  // Pre-record "triaged" for each close candidate before the API fan-out so
  // the decision is persisted even if the GitHub close API fails. Mirrors the
  // new-issues path (phase 1) where insertIssueAction is called before
  // closeIssueWithComment to prevent an infinite close-retry loop on API failure.
  // All inserts are wrapped in a single transaction so a mid-loop crash cannot
  // leave a partial set persisted — either all candidates are marked or none,
  // preventing false negatives where some issues are skipped on the next cycle.
  if (db && closeCandidates.length > 0) {
    db.transaction(() => {
      for (const issue of closeCandidates) {
        insertIssueAction(db, cycleCount, issue.number, TRIAGE_ACTION_NAME);
      }
    })();
  }

  const closeResults = await Promise.all(
    closeCandidates.map((issue) =>
      closeIssueWithComment(
        issue.number,
        cycleCount,
        TRIAGE_ALREADY_ON_BOARD_COMMENT,
        db,
        "closed",
        repo ?? undefined,
      )
        .then((wasClosed) => ({ issueNumber: issue.number, wasClosed }))
        .catch((err) => {
          // Issue may have been closed externally between filter and close call
          console.warn(`[triage] Could not close already-on-board issue #${issue.number} (non-fatal): ${errorMessage(err)}`);
          return { issueNumber: issue.number, wasClosed: false };
        }),
    ),
  );
  for (const r of closeResults) {
    if (r.wasClosed) {
      result.closed.push(r.issueNumber);
    }
  }

  // New issues that need triage
  const newIssues = issues.filter((i) => !boardIssueNumbers.has(i.number));

  // Without a database we cannot deduplicate — skip triage entirely to avoid
  // creating duplicate roadmap entries on every cycle.
  if (!db) {
    console.warn(
      "[triage] No database available — skipping new-issue triage to prevent duplicate roadmap entries.",
    );
    return result;
  }

  // Filter out any issues already triaged in this or a previous cycle
  const untriaged = newIssues.filter(
    (i) => !hasIssueAction(db, i.number, TRIAGE_ACTION_NAME),
  );

  if (untriaged.length === 0) return result;

  // Call LLM for triage decisions
  const prompt = buildTriagePrompt(untriaged, boardItems);
  let triageText = "";

  try {
    // Resolve query function once: use injected dep or lazy-import the real SDK
    const queryFn =
      deps?.queryFn ??
      (await import("@anthropic-ai/claude-agent-sdk")).query;

    for await (const msg of queryFn({
      prompt,
      options: {
        model: resolveModel(),
        maxTurns: TRIAGE_MAX_TURNS,
        maxBudgetUsd: TRIAGE_MAX_BUDGET_USD,
        permissionMode: "dontAsk",
        allowedTools: [],
      },
    })) {
      const text = extractResultText(msg);
      if (text !== null) triageText = text;
    }
  } catch (err) {
    console.error(`[triage] LLM call failed (non-fatal): ${errorMessage(err)}`);
    return result;
  }

  const decisions = parseTriageResponse(triageText);
  result.decisions = decisions;

  // Validate decisions against our actual issue set
  const untriagedNumbers = new Set(untriaged.map((i) => i.number));

  const commentMap: Record<TriageDecision["action"], string> = {
    add_to_backlog: `Added to Bloom Evolution Roadmap backlog (cycle ${cycleCount}).`,
    already_done: `Resolved — tracked as Done on the roadmap (cycle ${cycleCount}).`,
    not_applicable: `Closing — not applicable or out of scope (cycle ${cycleCount}).`,
  };

  // Phase 1: process all decisions synchronously — add_to_backlog requires
  // disk writes (addLinkedItem) that must stay sequential; collect close tasks
  // for later fan-out.
  const closeTasks: Array<{ issueNumber: number; comment: string }> = [];
  // Guard against duplicate issueNumber entries in the LLM response — processing
  // the same issue twice could create orphaned roadmap entries AND close the
  // issue in a single cycle (e.g., add_to_backlog + not_applicable for #5).
  const processedIssueNumbers = new Set<number>();

  for (const decision of decisions) {
    if (!untriagedNumbers.has(decision.issueNumber)) {
      console.warn(
        `[triage] Ignoring LLM decision for issue #${decision.issueNumber} (action=${decision.action}) — not in the untriaged input set`,
      );
      continue;
    }
    if (processedIssueNumbers.has(decision.issueNumber)) {
      console.warn(
        `[triage] Duplicate decision for issue #${decision.issueNumber} (action=${decision.action}) — ignoring, keeping first occurrence`,
      );
      continue;
    }
    processedIssueNumbers.add(decision.issueNumber);
    const issue = untriaged.find((i) => i.number === decision.issueNumber);
    if (!issue) continue;

    try {
      // Done-gate: if LLM says already_done but no "Done" board item is linked
      // to this issue, downgrade to add_to_backlog as a second line of defense.
      const effectiveAction: TriageDecision["action"] =
        decision.action === "already_done" &&
        !boardItems.some(
          (item) =>
            item.status === TRIAGE_BOARD_STATUS_DONE &&
            item.linkedIssueNumber === decision.issueNumber,
        )
          ? "add_to_backlog"
          : decision.action;

      if (effectiveAction === "add_to_backlog") {
        if (repo && isValidRepo(repo)) {
          try {
            addLinkedItem(projectConfig, issue.number, issue.title, issue.body);
            result.addedToBacklog.push(issue.number);
          } catch (addErr) {
            console.error(`[triage] addLinkedItem failed for issue #${decision.issueNumber} (non-fatal): ${errorMessage(addErr)}`);
          }
        }
        // Mark as triaged regardless of addLinkedItem outcome so the decision is
        // always recorded and this issue is never re-sent to the LLM next cycle.
        // Without this, a transient addLinkedItem failure (e.g., disk full, file
        // locked) would cause infinite re-triage loops and potential duplicates.
        insertIssueAction(db, cycleCount, issue.number, TRIAGE_ACTION_NAME);
      }

      // add_to_backlog issues stay open — they will be closed once the linked
      // roadmap item reaches "Done", providing a clear resolution trail.
      // already_done and not_applicable issues are queued for concurrent closing.
      if (effectiveAction !== "add_to_backlog") {
        // Mark as triaged immediately (before the close API call) so the decision
        // is always persisted. If the GitHub close API fails in phase 2, the issue
        // will still be filtered by the hasIssueAction(TRIAGE_ACTION_NAME) guard on the
        // next cycle — preventing an infinite re-triage loop. Mirrors the
        // add_to_backlog path above where insertIssueAction is called before
        // addLinkedItem, making all three branches symmetric.
        insertIssueAction(db, cycleCount, issue.number, TRIAGE_ACTION_NAME);
        closeTasks.push({
          issueNumber: issue.number,
          comment: `${commentMap[effectiveAction]}\n\n${decision.reason}`,
        });
      }
    } catch (err) {
      // Best-effort: don't let a single issue failure block others
      console.error(`[triage] Failed to process issue #${decision.issueNumber} (action=${decision.action}): ${errorMessage(err)}`);
    }
  }

  // Phase 2: fan out close API calls concurrently — same pattern as the
  // alreadyOnBoard loop above, eliminating linear latency scaling when multiple
  // already_done / not_applicable decisions are returned in a single cycle.
  const decisionCloseResults = await Promise.all(
    closeTasks.map(({ issueNumber, comment }) =>
      closeIssueWithComment(issueNumber, cycleCount, comment, db, "closed", repo ?? undefined)
        .then((wasClosed) => ({ issueNumber, wasClosed }))
        .catch((err) => {
          console.error(`[triage] Failed to close issue #${issueNumber} (non-fatal): ${errorMessage(err)}`);
          return { issueNumber, wasClosed: false };
        }),
    ),
  );
  for (const r of decisionCloseResults) {
    if (r.wasClosed) {
      result.closed.push(r.issueNumber);
    }
  }

  return result;
}
