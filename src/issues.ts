import { execFileSync } from "child_process";
import type Database from "better-sqlite3";
import { errorMessage } from "./errors.js";
import { githubApiRequest } from "./github-app.js";
import { insertIssueAction, hasIssueAction } from "./db.js";
import type { ProjectItem } from "./planning.js";

export interface CommunityIssue {
  number: number;
  title: string;
  body: string;
  reactions: number;
}

export function detectRepo(): string | null {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf-8", timeout: 10_000 }).trim();
    const match = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Validate that an issue number is a positive integer — safe for shell interpolation. */
export function isSafeIssueNumber(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

/** Only allow "owner/repo" with safe characters — no shell metacharacters. */
export function isValidRepo(repo: string): boolean {
  return /^[\w.\-]+\/[\w.\-]+$/.test(repo);
}

export async function fetchCommunityIssues(): Promise<CommunityIssue[]> {
  const repo = detectRepo();
  if (!repo || !isValidRepo(repo)) return [];

  const FETCH_TIMEOUT_MS = 10_000;

  async function doFetch(): Promise<CommunityIssue[]> {
    const res = await githubApiRequest(
      "GET",
      `/repos/${repo}/issues?labels=agent-input&state=open&per_page=20`,
    );
    if (!res.ok) return [];

    const raw: unknown = await res.json();
    if (!Array.isArray(raw)) return [];

    return raw
      .filter(
        (item): item is { number: number; title: string; body: string; reactions: { total_count: number } } =>
          typeof item === "object" &&
          item !== null &&
          typeof item.number === "number" &&
          typeof item.title === "string",
      )
      .map((i) => ({
        number: i.number,
        title: i.title,
        body: typeof i.body === "string" ? i.body : "",
        reactions:
          typeof i.reactions === "object" &&
          i.reactions !== null &&
          typeof i.reactions.total_count === "number"
            ? i.reactions.total_count
            : 0,
      }))
      .sort((a, b) => b.reactions - a.reactions);
  }

  try {
    return await Promise.race([
      doFetch(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`fetchCommunityIssues timed out after ${FETCH_TIMEOUT_MS}ms`)),
          FETCH_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    console.error(`[issues] fetchCommunityIssues failed (non-fatal): ${errorMessage(err)}`);
    return [];
  }
}

/**
 * Close an issue with a comment. Generic helper used by triage and legacy resolution.
 * Best-effort — failures are swallowed to never block evolution.
 */
export async function closeIssueWithComment(
  issueNumber: number,
  cycleCount: number,
  comment: string,
  db?: Database.Database,
  action: string = "closed",
  precomputedRepo?: string,
): Promise<boolean> {
  const repo = precomputedRepo ?? detectRepo();
  if (!repo || !isValidRepo(repo)) return false;
  if (!isSafeIssueNumber(issueNumber)) return false;

  // Skip if already performed this action locally
  if (db && hasIssueAction(db, issueNumber, action)) return true;

  try {
    // Post closing comment
    await githubApiRequest("POST", `/repos/${repo}/issues/${issueNumber}/comments`, {
      body: comment,
    });

    // Close the issue
    await githubApiRequest("PATCH", `/repos/${repo}/issues/${issueNumber}`, {
      state: "closed",
    });

    // Record the action
    if (db) insertIssueAction(db, cycleCount, issueNumber, action);

    return true;
  } catch (err) {
    console.error(`[issues] closeIssueWithComment failed for issue #${issueNumber} (non-fatal): ${errorMessage(err)}`);
    return false;
  }
}

/**
 * Fetch +1 reaction counts from GitHub for roadmap items that have a linked
 * issue number, and return a new array with the reactions field populated.
 * Items without a linked issue are returned unchanged.
 * Best-effort — any per-issue failure is silently skipped.
 */
export async function syncReactionsToItems(items: ProjectItem[]): Promise<ProjectItem[]> {
  const repo = detectRepo();
  if (!repo || !isValidRepo(repo)) return items;

  const linked = items.filter((i) => i.linkedIssueNumber !== null);
  if (linked.length === 0) return items;

  const reactionMap = new Map<number, number>();

  await Promise.allSettled(
    linked.map(async (item) => {
      const issueNumber = item.linkedIssueNumber!;
      const res = await githubApiRequest("GET", `/repos/${repo}/issues/${issueNumber}`);
      if (!res.ok) return;
      const data: unknown = await res.json();
      if (
        typeof data === "object" &&
        data !== null &&
        "reactions" in data &&
        typeof (data as Record<string, unknown>).reactions === "object" &&
        (data as Record<string, unknown>).reactions !== null
      ) {
        const reactions = (data as Record<string, unknown>).reactions as Record<string, unknown>;
        const plusOne = typeof reactions["+1"] === "number" ? reactions["+1"] : 0;
        reactionMap.set(issueNumber, plusOne);
      }
    }),
  );

  if (reactionMap.size === 0) return items;

  return items.map((item) =>
    item.linkedIssueNumber !== null && reactionMap.has(item.linkedIssueNumber)
      ? { ...item, reactions: reactionMap.get(item.linkedIssueNumber)! }
      : item,
  );
}