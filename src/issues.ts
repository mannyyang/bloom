import { execSync } from "child_process";
import { githubApiRequest } from "./github-app.js";

export interface CommunityIssue {
  number: number;
  title: string;
  body: string;
  reactions: number;
}

function detectRepo(): string | null {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const url = execSync("git remote get-url origin", { encoding: "utf-8", timeout: 10_000 }).trim();
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

export function fetchCommunityIssues(): CommunityIssue[] {
  const repo = detectRepo();
  if (!repo || !isValidRepo(repo)) return [];

  try {
    const raw = execSync(
      `gh issue list --repo ${repo} --label "agent-input" --state open --json number,title,body,reactionGroups --limit 20`,
      { encoding: "utf-8", timeout: 10_000 },
    );

    const issues = JSON.parse(raw) as Array<{
      number: number;
      title: string;
      body: string;
      reactionGroups: Array<{ content: string; users: { totalCount: number } }>;
    }>;

    return issues
      .map((i) => ({
        number: i.number,
        title: i.title,
        body: i.body,
        reactions: i.reactionGroups.reduce((sum, g) => sum + g.users.totalCount, 0),
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
    const res = await githubApiRequest("GET", `/repos/${repo}/issues/${issueNumber}/comments`);
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
): Promise<void> {
  if (issues.length === 0) return;
  const repo = detectRepo();
  if (!repo || !isValidRepo(repo)) return;

  for (const issue of issues) {
    try {
      if (!isSafeIssueNumber(issue.number)) continue;

      if (await hasBloomComment(issue.number, repo)) {
        // Already seen in a prior cycle — close the issue so it doesn't
        // accumulate indefinitely. Contributors had one full cycle to react.
        await githubApiRequest("PATCH", `/repos/${repo}/issues/${issue.number}`, {
          state: "closed",
          state_reason: "completed",
        }).catch(() => {});
        continue;
      }

      await githubApiRequest("POST", `/repos/${repo}/issues/${issue.number}/comments`, {
        body: `Seen by Bloom in cycle ${cycleCount}. Thank you for your input!`,
      });

      // Add label — best-effort
      await githubApiRequest("POST", `/repos/${repo}/issues/${issue.number}/labels`, {
        labels: ["bloom-reviewed"],
      }).catch(() => {});
    } catch {
      // Best-effort: don't let a failed comment block evolution.
    }
  }
}
