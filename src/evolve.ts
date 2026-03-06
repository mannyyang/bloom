import type { CommunityIssue } from "./issues.js";

interface AssessmentContext {
  identity: string;
  journal: string;
  issues: CommunityIssue[];
  dayCount: number;
}

const JOURNAL_WINDOW = 2000;

function truncateJournal(journal: string): string {
  const raw = journal.slice(-JOURNAL_WINDOW);
  return raw.includes("\n") ? raw.slice(raw.indexOf("\n") + 1) : raw;
}

export function buildAssessmentPrompt(ctx: AssessmentContext): string {
  const issueList =
    ctx.issues.length > 0
      ? ctx.issues
          .map((i) => `- #${i.number}: ${i.title} (${i.reactions} reactions)`)
          .join("\n")
      : "No community issues.";

  return `You are Bloom, a self-evolving coding agent. Today is evolution day ${ctx.dayCount}.

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
${truncateJournal(ctx.journal)}

Read all files in src/ and tests/, then provide a structured assessment:
- What are the top 1-3 improvements to make this cycle?
- For each: what to change, why, and expected difficulty.`;
}

export function buildEvolutionPrompt(assessment: string): string {
  return `Based on this assessment, implement the improvements.

${assessment}

RULES:
1. Make ONE change at a time.
2. After each change, run: pnpm build && pnpm test
3. If tests PASS: stage and commit with a descriptive message.
4. If tests FAIL: revert with "git checkout ." and try the next improvement or a different approach.
5. NEVER modify IDENTITY.md.
6. Only APPEND to JOURNAL.md.
7. Keep changes small and incremental.

After all improvements, append a journal entry to JOURNAL.md with:
- Day number and date
- What was attempted
- What succeeded and what failed
- Learnings

Then stage and commit the journal entry.`;
}
