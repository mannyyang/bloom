import type Database from "better-sqlite3";
import type { CommunityIssue } from "./issues.js";
import { closeIssueWithComment } from "./issues.js";
import { hasIssueAction, insertIssueAction } from "./db.js";
import { errorMessage } from "./errors.js";
import { addLinkedItem, type ProjectConfig, type ProjectItem } from "./planning.js";
import { detectRepo, isValidRepo } from "./issues.js";
import type { QueryFn } from "./agent-phases.js";
import { extractResultText } from "./usage.js";

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
        `- #${i.number}: "${i.title}" (${i.reactions} reactions)\n  ${i.body.slice(0, 300)}`,
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
- "already_done": This capability/fix already exists in the codebase or board.
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
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (item): item is TriageDecision =>
        typeof item === "object" &&
        item !== null &&
        typeof item.issueNumber === "number" &&
        ["add_to_backlog", "already_done", "not_applicable"].includes(
          item.action,
        ) &&
        typeof item.reason === "string",
    );
  } catch {
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

  // Close any issues that are already on the board but still open
  const alreadyOnBoard = issues.filter((i) => boardIssueNumbers.has(i.number));
  for (const issue of alreadyOnBoard) {
    if (db && hasIssueAction(db, issue.number, "triaged")) continue;
    await closeIssueWithComment(
      issue.number,
      cycleCount,
      "This issue is already tracked on the Bloom Evolution Roadmap.",
      db,
      "triaged",
      repo ?? undefined,
    );
    result.closed.push(issue.number);
  }

  // New issues that need triage
  const newIssues = issues.filter((i) => !boardIssueNumbers.has(i.number));

  // Also filter out any issues already triaged in this or a previous cycle
  const untriaged = newIssues.filter(
    (i) => !db || !hasIssueAction(db, i.number, "triaged"),
  );

  if (untriaged.length === 0) return result;

  // Call LLM for triage decisions
  const prompt = buildTriagePrompt(untriaged, boardItems);
  let triageText = "";

  try {
    const queryFn = deps?.queryFn;
    if (!queryFn) {
      // Lazy-import to avoid hard dependency when deps are injected
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      const realQuery = sdk.query;
      for await (const msg of realQuery({
        prompt,
        options: {
          model: "claude-sonnet-4-20250514",
          maxTurns: 3,
          maxBudgetUsd: 0.5,
          permissionMode: "dontAsk",
          allowedTools: [],
        },
      })) {
        const text = extractResultText(msg);
        if (text !== null) triageText = text;
      }
    } else {
      for await (const msg of queryFn({
        prompt,
        options: {
          model: "claude-sonnet-4-20250514",
          maxTurns: 3,
          maxBudgetUsd: 0.5,
          permissionMode: "dontAsk",
          allowedTools: [],
        },
      })) {
        const text = extractResultText(msg);
        if (text !== null) triageText = text;
      }
    }
  } catch (err) {
    console.error(`[triage] LLM call failed (non-fatal): ${errorMessage(err)}`);
    return result;
  }

  const decisions = parseTriageResponse(triageText);
  result.decisions = decisions;

  // Validate decisions against our actual issue set
  const untriagedNumbers = new Set(untriaged.map((i) => i.number));

  for (const decision of decisions) {
    if (!untriagedNumbers.has(decision.issueNumber)) continue;
    const issue = untriaged.find((i) => i.number === decision.issueNumber);
    if (!issue) continue;

    try {
      const commentMap: Record<TriageDecision["action"], string> = {
        add_to_backlog: `Added to Bloom Evolution Roadmap backlog (cycle ${cycleCount}).`,
        already_done: `Closing — this appears to already be addressed (cycle ${cycleCount}).`,
        not_applicable: `Closing — not applicable or out of scope (cycle ${cycleCount}).`,
      };

      if (decision.action === "add_to_backlog" && repo && isValidRepo(repo)) {
        addLinkedItem(projectConfig, repo, issue.number, issue.title, issue.body);
        result.addedToBacklog.push(issue.number);
      }

      await closeIssueWithComment(
        issue.number,
        cycleCount,
        `${commentMap[decision.action]}\n\n${decision.reason}`,
        db,
        "triaged",
        repo ?? undefined,
      );
      result.closed.push(issue.number);
    } catch (err) {
      // Best-effort: don't let a single issue failure block others
      console.error(`[triage] Failed to process issue #${decision.issueNumber} (action=${decision.action}): ${errorMessage(err)}`);
    }
  }

  return result;
}
