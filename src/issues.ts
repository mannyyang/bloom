import { execFileSync } from "child_process";
import type Database from "better-sqlite3";
import { githubApiRequest } from "./github-app.js";
import { insertIssueAction, hasIssueAction } from "./db.js";

export interface ResolvedIssue {
  issueNumber: number;
  reason: string;
}

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
  } catch {
    return [];
  }
}

/**
 * Check whether Bloom has already posted a "Seen by Bloom" comment on the
 * given issue, to avoid duplicate comment spam across cycles.
 */
async function hasBloomComment(
  issueNumber: number,
  repo: string,
): Promise<boolean> {
  try {
    const res = await githubApiRequest("GET", `/repos/${repo}/issues/${issueNumber}/comments?per_page=100`);
    if (!res.ok) return false;
    const comments = (await res.json()) as Array<{ body: string }>;
    return comments.some((c) => c.body.includes("Seen by Bloom"));
  } catch {
    return false;
  }
}

/**
 * Post a "seen by Bloom" comment on each community issue so contributors
 * know their input was considered during this cycle.  Skips issues that
 * already have a Bloom comment to avoid duplicate spam.  Also adds a
 * "bloom-reviewed" label for at-a-glance visibility.  Failures are
 * swallowed — a missing comment must never block evolution.
 */
export async function acknowledgeIssues(
  issues: CommunityIssue[],
  cycleCount: number,
  db?: Database.Database,
): Promise<void> {
  if (issues.length === 0) return;
  const repo = detectRepo();
  if (!repo || !isValidRepo(repo)) return;

  for (const issue of issues) {
    try {
      if (!isSafeIssueNumber(issue.number)) continue;

      // Skip if already acknowledged locally
      if (db && hasIssueAction(db, issue.number, "acknowledged")) continue;

      if (await hasBloomComment(issue.number, repo)) {
        // Record locally even if we found it via API, to avoid future API calls
        if (db) insertIssueAction(db, cycleCount, issue.number, "acknowledged");
        continue;
      }

      await githubApiRequest("POST", `/repos/${repo}/issues/${issue.number}/comments`, {
        body: `Seen by Bloom in cycle ${cycleCount}. Thank you for your input!`,
      });

      // Add label — best-effort
      await githubApiRequest("POST", `/repos/${repo}/issues/${issue.number}/labels`, {
        labels: ["bloom-reviewed"],
      }).catch(() => {});

      // Record the acknowledgement
      if (db) insertIssueAction(db, cycleCount, issue.number, "acknowledged");
    } catch {
      // Best-effort: don't let a failed comment block evolution.
    }
  }
}

/**
 * Check whether any commit in the repo references the given issue number.
 * Searches git log for patterns like #N, issue #N, etc.
 */
export function hasCommitForIssue(issueNumber: number): boolean {
  try {
    const output = execFileSync(
      "git", ["log", "--oneline", "--all", `--grep=#${issueNumber}[^0-9]`, "--extended-regexp"],
      { encoding: "utf-8", timeout: 10_000 },
    ).trim();
    if (output.length > 0) return true;
    // Also match #N at end of line
    const output2 = execFileSync(
      "git", ["log", "--oneline", "--all", `--grep=#${issueNumber}$`, "--extended-regexp"],
      { encoding: "utf-8", timeout: 10_000 },
    ).trim();
    return output2.length > 0;
  } catch {
    return false;
  }
}

/**
 * Close a resolved issue with a comment explaining the resolution.
 * Best-effort — failures are swallowed to never block evolution.
 */
export async function closeResolvedIssue(
  issueNumber: number,
  cycleCount: number,
  reason: string,
  db?: Database.Database,
): Promise<boolean> {
  const repo = detectRepo();
  if (!repo || !isValidRepo(repo)) return false;
  if (!isSafeIssueNumber(issueNumber)) return false;

  // Skip if already closed locally
  if (db && hasIssueAction(db, issueNumber, "closed")) return true;

  try {
    // Post closing comment
    await githubApiRequest("POST", `/repos/${repo}/issues/${issueNumber}/comments`, {
      body: `Resolved by Bloom in cycle ${cycleCount}.\n\n${reason}`,
    });

    // Close the issue
    await githubApiRequest("PATCH", `/repos/${repo}/issues/${issueNumber}`, {
      state: "closed",
    });

    // Record the close action
    if (db) insertIssueAction(db, cycleCount, issueNumber, "closed");

    return true;
  } catch {
    return false;
  }
}
