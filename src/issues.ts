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
    const url = execSync("git remote get-url origin", { encoding: "utf-8" }).trim();
    const match = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function fetchCommunityIssues(): CommunityIssue[] {
  const repo = detectRepo();
  if (!repo) return [];

  try {
    const raw = execSync(
      `gh issue list --repo ${repo} --label "agent-input" --state open --json number,title,body,reactionGroups --limit 20`,
      { encoding: "utf-8" },
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
