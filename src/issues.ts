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

/** Only allow "owner/repo" with safe characters — no shell metacharacters. */
function isValidRepo(repo: string): boolean {
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
 * Post a "seen by Bloom" comment on each community issue so contributors
 * know their input was considered during this cycle.  Failures are
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
      execSync(
        `gh issue comment ${issue.number} --repo ${repo} --body "Seen by Bloom in cycle ${cycleCount}. Thank you for your input!"`,
        { timeout: 10_000 },
      );
    } catch {
      // Best-effort: don't let a failed comment block evolution.
    }
  }
}
