import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { errorMessage } from "./errors.js";
import { githubApiRequest } from "./github-app.js";
import { insertIssueAction, hasIssueAction } from "./db.js";
import type { ProjectItem } from "./planning.js";

export const ISSUES_PER_PAGE = 20;
export const FETCH_TIMEOUT_MS = 10_000;
export const ISSUES_DEFAULT_ACTION = "closed";

/**
 * Timeout for the syncReactionsToItems fan-out. If all per-issue API calls
 * haven't settled within this window, the whole operation is abandoned and
 * the original items are returned unchanged — mirroring the fetchCommunityIssues
 * timeout guard so a slow GitHub API never blocks the evolution cycle.
 */
export const SYNC_REACTIONS_TIMEOUT_MS = 15_000;

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

  async function doFetch(): Promise<CommunityIssue[]> {
    const res = await githubApiRequest(
      "GET",
      `/repos/${repo}/issues?labels=agent-input&state=open&per_page=${ISSUES_PER_PAGE}`,
    );
    if (!res.ok) {
      console.warn(`[issues] fetchCommunityIssues: non-ok response ${res.status} ${res.statusText}`);
      return [];
    }

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
 *
 * @param issueNumber - GitHub issue number to close.
 * @param cycleCount  - Current evolution cycle, stored in the DB dedup record.
 * @param comment     - Text of the closing comment posted to GitHub.
 * @param db          - Optional SQLite database used for dedup checks.
 * @param action      - Label written to the DB dedup record only; it does NOT
 *                      control the GitHub state transition — the issue is always
 *                      closed via `state: ISSUES_DEFAULT_ACTION` ("closed").
 *                      Passing a value like "reopen" here will record "reopen"
 *                      in the DB but still send `state: "closed"` to GitHub.
 * @param precomputedRepo - Optional pre-resolved "owner/repo" string; detected
 *                          from the environment when omitted.
 */
export async function closeIssueWithComment(
  issueNumber: number,
  cycleCount: number,
  comment: string,
  db?: Database.Database,
  action: string = ISSUES_DEFAULT_ACTION,
  precomputedRepo?: string,
): Promise<boolean> {
  const repo = precomputedRepo ?? detectRepo();
  if (!repo || !isValidRepo(repo)) return false;
  if (!isSafeIssueNumber(issueNumber)) return false;

  // Skip if already performed this action locally
  if (db && hasIssueAction(db, issueNumber, action)) return true;

  try {
    // Post closing comment
    const commentRes = await githubApiRequest("POST", `/repos/${repo}/issues/${issueNumber}/comments`, {
      body: comment,
    });
    if (!commentRes.ok) {
      console.warn(`[issues] closeIssueWithComment: non-ok response ${commentRes.status} on POST comment for issue #${issueNumber}`);
      return false;
    }

    // Close the issue
    const closeRes = await githubApiRequest("PATCH", `/repos/${repo}/issues/${issueNumber}`, {
      state: ISSUES_DEFAULT_ACTION,
    });
    if (!closeRes.ok) {
      console.warn(`[issues] closeIssueWithComment: non-ok response ${closeRes.status} on PATCH close for issue #${issueNumber}`);
      return false;
    }

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

  try {
    await Promise.race([
      Promise.allSettled(
        linked.map(async (item) => {
          const issueNumber = item.linkedIssueNumber!;
          const res = await githubApiRequest("GET", `/repos/${repo}/issues/${issueNumber}`);
          if (!res.ok) {
            console.warn(`[issues] syncReactionsToItems: non-ok response ${res.status} for issue #${issueNumber}`);
            return;
          }
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
      ),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`syncReactionsToItems timed out after ${SYNC_REACTIONS_TIMEOUT_MS}ms`)),
          SYNC_REACTIONS_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    console.warn(`[issues] syncReactionsToItems: reaction sync timed out (non-fatal): ${errorMessage(err)}`);
    return items;
  }

  if (reactionMap.size === 0) return items;

  return items.map((item) =>
    item.linkedIssueNumber !== null && reactionMap.has(item.linkedIssueNumber)
      ? { ...item, reactions: reactionMap.get(item.linkedIssueNumber)! }
      : item,
  );
}