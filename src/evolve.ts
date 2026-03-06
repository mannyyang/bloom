import type { CommunityIssue } from "./issues.js";

export interface AssessmentContext {
  identity: string;
  journalSummary: string;
  issues: CommunityIssue[];
  cycleCount: number;
}

export function buildAssessmentPrompt(ctx: AssessmentContext): string {
  const issueList =
    ctx.issues.length > 0
      ? ctx.issues
          .map((i) => `- #${i.number}: ${i.title} (${i.reactions} reactions)`)
          .join("\n")
      : "No community issues.";

  return `You are Bloom, a self-evolving coding agent. This is evolution cycle ${ctx.cycleCount}.

Read your own source code in src/ and assess what to improve. Consider:
1. Bugs or correctness issues
2. Community requests (prioritized by reactions):
${issueList}
3. Test coverage gaps
4. Code clarity improvements
5. New capabilities aligned with your purpose

Your constitution:
${ctx.identity}

Recent journal entries:
${ctx.journalSummary}

Read all files in src/ and tests/, then provide a structured assessment:
- What are the top 1-3 improvements to make this cycle?
- For each: what to change, why, and expected difficulty.`;
}

interface EvolutionContext {
  usageContext?: string;
  outcomeContext?: string;
}

export function buildEvolutionPrompt(assessment: string, context?: EvolutionContext): string {
  const usageSection = context?.usageContext
    ? `\n\nResource usage so far this cycle:\n${context.usageContext}\n`
    : "";

  const outcomeSection = context?.outcomeContext
    ? `\n\nCycle outcome metrics so far:\n${context.outcomeContext}\n`
    : "";

  return `Based on this assessment, implement the improvements.

${assessment}${usageSection}${outcomeSection}

RULES:
1. Make ONE change at a time.
2. After each change, run: pnpm build && pnpm test
3. If tests PASS: stage and commit with a descriptive message.
4. If tests FAIL: revert with "git checkout ." and try the next improvement or a different approach.
5. NEVER modify IDENTITY.md.
6. Do NOT write to JOURNAL.md — journal entries are now stored in SQLite and managed by the orchestrator.
7. Keep changes small and incremental.

After all improvements, provide a structured summary in your final response with these sections clearly labeled:
- ATTEMPTED: What was attempted this cycle
- SUCCEEDED: What succeeded
- FAILED: What failed
- LEARNINGS: Key insights`;
}
