import { execSync } from "child_process";

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
export function hasBloomComment(
  issueNumber: number,
  repo: string,
): boolean {
  if (!isSafeIssueNumber(issueNumber)) return false;
  if (!isValidRepo(repo)) return false;
  try {
    const raw = execSync(
      `gh issue view ${issueNumber} --repo ${repo} --json comments`,
      { encoding: "utf-8", timeout: 10_000 },
    );
    const data = JSON.parse(raw) as {
      comments: Array<{ body: string }>;
    };
    return data.comments.some((c) => c.body.includes("Seen by Bloom"));
  } catch {
    // If we can't check, assume not commented (will attempt to post).
    return false;
  }
}

/**
 * Add a label to an issue.  Best-effort: failures are swallowed so a
 * missing label or permission issue never blocks evolution.
 */
export function labelIssue(
  issueNumber: number,
  repo: string,
  label: string,
): void {
  if (!isSafeIssueNumber(issueNumber)) return;
  if (!isValidRepo(repo)) return;
  // Sanitise label — only allow printable non-shell-meta characters.
  if (!/^[\w.\- ]+$/.test(label)) return;
  try {
    execSync(
      `gh issue edit ${issueNumber} --repo ${repo} --add-label "${label}"`,
      { timeout: 10_000 },
    );
  } catch {
    // Best-effort: don't let a failed label block evolution.
  }
}

/**
 * Post a "seen by Bloom" comment on each community issue so contributors
 * know their input was considered during this cycle.  Skips issues that
 * already have a Bloom comment to avoid duplicate spam.  Also adds a
 * "bloom-reviewed" label for at-a-glance visibility.  Failures are
 * swallowed — a missing comment must never block evolution.
 */
export function acknowledgeIssues(
  issues: CommunityIssue[],
  cycleCount: number,
): void {
  if (issues.length === 0) return;
  const repo = detectRepo();
  if (!repo || !isValidRepo(repo)) return;

  for (const issue of issues) {
    try {
      if (hasBloomComment(issue.number, repo)) continue;
      execSync(
        `gh issue comment ${issue.number} --repo ${repo} --body "Seen by Bloom in cycle ${cycleCount}. Thank you for your input!"`,
        { timeout: 10_000 },
      );
      labelIssue(issue.number, repo, "bloom-reviewed");
    } catch {
      // Best-effort: don't let a failed comment block evolution.
    }
  }
}
