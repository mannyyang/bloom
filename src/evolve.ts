import type { CommunityIssue } from "./issues.js";

export interface AssessmentContext {
  identity: string;
  journalSummary: string;
  issues: CommunityIssue[];
  cycleCount: number;
  cycleStatsText?: string;
  memoryContext?: string;
  planningContext?: string;
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
${ctx.cycleStatsText ? `\nYour track record:\n${ctx.cycleStatsText}\n` : ""}${ctx.memoryContext ? `\nYour accumulated knowledge:\n${ctx.memoryContext}\n` : ""}${ctx.planningContext ? `\n${ctx.planningContext}\n` : ""}
Read all files in src/ and tests/, then provide a structured assessment:
- What are the top 1-3 improvements to make this cycle?
- For each: what to change, why, and expected difficulty.`;
}

interface EvolutionContext {
  usageContext?: string;
  outcomeContext?: string;
}

/**
 * Parse the structured summary from an evolution result.
 * Extracts ATTEMPTED, SUCCEEDED, FAILED, and LEARNINGS sections.
 */
export function parseEvolutionResult(result: string): Record<string, string> {
  const sections: Record<string, string> = {
    attempted: "",
    succeeded: "",
    failed: "",
    learnings: "",
    strategic_context: "",
  };

  const sectionMap: Record<string, string> = {
    "ATTEMPTED": "attempted",
    "SUCCEEDED": "succeeded",
    "FAILED": "failed",
    "LEARNINGS": "learnings",
    "STRATEGIC_CONTEXT": "strategic_context",
  };

  let currentSection = "";
  for (const line of result.split("\n")) {
    const trimmed = line.trim();
    // Check for section headers in various formats:
    // "ATTEMPTED:", "**ATTEMPTED**:", "## ATTEMPTED", "## **ATTEMPTED**", "- ATTEMPTED:"
    let matched = false;
    for (const [marker, key] of Object.entries(sectionMap)) {
      const patterns = [
        `${marker}:`,           // ATTEMPTED:
        `**${marker}**:`,       // **ATTEMPTED**:
        `**${marker}:**`,       // **ATTEMPTED:**
        `## ${marker}`,         // ## ATTEMPTED
        `## **${marker}**`,     // ## **ATTEMPTED**
        `- ${marker}:`,         // - ATTEMPTED:
      ];
      if (patterns.some(p => trimmed.startsWith(p))) {
        currentSection = key;
        const rest = trimmed.replace(/^(?:##\s+|-\s+)?\*{0,2}[A-Z]+:?\*{0,2}:?\s*/, "");
        if (rest) sections[currentSection] += rest + "\n";
        matched = true;
        break;
      }
    }
    if (currentSection && !matched) {
      sections[currentSection] += line + "\n";
    }
  }

  // Trim trailing whitespace
  for (const key of Object.keys(sections)) {
    sections[key] = sections[key].trim();
  }

  return sections;
}

/**
 * Count the number of improvement items in a section text.
 * Counts lines starting with "- " or numbered items like "1. ", "2. ".
 */
export function countImprovements(text: string): number {
  if (!text) return 0;
  let count = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.match(/^-\s+/) || trimmed.match(/^\d+\.\s+/)) {
      count++;
    }
  }
  return count;
}

/**
 * Extract issue numbers mentioned in the "succeeded" section that match known open issues.
 * Looks for patterns like #3, issue #3, community issue #3.
 */
export function extractResolvedIssueNumbers(
  succeededText: string,
  openIssueNumbers: number[],
): number[] {
  if (!succeededText || openIssueNumbers.length === 0) return [];
  const openSet = new Set(openIssueNumbers);
  const mentioned = new Set<number>();
  for (const match of succeededText.matchAll(/#(\d+)/g)) {
    const num = parseInt(match[1], 10);
    if (openSet.has(num)) mentioned.add(num);
  }
  return [...mentioned];
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
8. After completing code changes, update README.md and any other public-facing documentation to accurately reflect the current state of the agent — its features, architecture, and capabilities. Do not leave docs stale.

After all improvements, end your response with a structured summary using EXACTLY this format (no markdown headers, no bold, just the marker followed by a colon):

ATTEMPTED: <what was attempted>
SUCCEEDED: <what succeeded>
FAILED: <what failed>
LEARNINGS: <key insights — optionally prefix each with [pattern], [anti-pattern], [domain], or [tool-usage]>
STRATEGIC_CONTEXT: <2-4 sentences about your current focus areas, trajectory, and ongoing goals>`;
}
