import { execFileSync } from "child_process";
import type Database from "better-sqlite3";
import { githubApiRequest } from "./github-app.js";
import { insertIssueAction, hasIssueAction } from "./db.js";

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

  try {
    const res = await githubApiRequest(
      "GET",
      `/repos/${repo}/issues?labels=agent-input&state=open&per_page=20`,
    );
    if (!res.ok) return [];

    const issues = (await res.json()) as Array<{
      number: number;
      title: string;
      body: string;
      reactions: { total_count: number };
    }>;

    return issues
      .map((i) => ({
        number: i.number,
        title: i.title,
        body: i.body ?? "",
        reactions: i.reactions?.total_count ?? 0,
      }))
      .sort((a, b) => b.reactions - a.reactions);
  } catch (err) {
    console.error(`[issues] fetchCommunityIssues failed (non-fatal): ${(err as Error).message}`);
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
): Promise<boolean> {
  const repo = detectRepo();
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
    console.error(`[issues] closeIssueWithComment failed for issue #${issueNumber} (non-fatal): ${(err as Error).message}`);
    return false;
  }
}