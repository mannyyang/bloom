/** Maximum characters allowed for the assessment passed into the evolution prompt. */
export const ASSESSMENT_CHAR_LIMIT = 2000;

export interface AssessmentContext {
  journalSummary: string;
  cycleCount: number;
  cycleStatsText?: string;
  memoryContext?: string;
  planningContext?: string;
}

/**
 * Build the prompt for the assessment phase.
 * Note: `identity` is intentionally absent here — it is passed separately as
 * a systemPrompt to the SDK (see assess.ts and index.ts), so it does not need
 * to be embedded in the user-facing prompt text.
 */
export function buildAssessmentPrompt(ctx: AssessmentContext): string {
  return `This is evolution cycle ${ctx.cycleCount}.

Read src/ and tests/, then list top 1-3 improvements (bugs, roadmap items, test gaps, clarity, new capabilities) — for each: what/why/difficulty. Keep your assessment under ${ASSESSMENT_CHAR_LIMIT} characters — it is passed directly into the implementation prompt.

Recent journal entries:
${ctx.journalSummary}
${ctx.cycleStatsText ? `\nYour track record:\n${ctx.cycleStatsText}\n` : ""}${ctx.memoryContext ? `\nYour accumulated knowledge:\n${ctx.memoryContext}\n` : ""}${ctx.planningContext ? `\n${ctx.planningContext}\n` : ""}`;
}

/** Options passed to buildEvolutionPrompt for injecting resource-usage and outcome sections. */
export interface EvolutionPromptContext {
  usageContext?: string;
  outcomeContext?: string;
}

/**
 * Strongly-typed structure for the five sections parsed from an evolution result.
 */
export interface EvolutionSections {
  attempted: string;
  succeeded: string;
  failed: string;
  learnings: string;
  strategic_context: string;
}

/** Maps uppercase marker names to their EvolutionSections keys. */
const SECTION_MAP: Record<string, keyof EvolutionSections> = {
  ATTEMPTED:        "attempted",
  SUCCEEDED:        "succeeded",
  FAILED:           "failed",
  LEARNINGS:        "learnings",
  STRATEGIC_CONTEXT: "strategic_context",
};

/**
 * Parse the structured summary from an evolution result.
 * Extracts ATTEMPTED, SUCCEEDED, FAILED, LEARNINGS, and STRATEGIC_CONTEXT sections.
 */
export function parseEvolutionResult(result: string): EvolutionSections {
  const sections: EvolutionSections = {
    attempted: "",
    succeeded: "",
    failed: "",
    learnings: "",
    strategic_context: "",
  };

  // Single regex handles all header formats:
  // "ATTEMPTED:", "**ATTEMPTED**:", "**ATTEMPTED:**", "## ATTEMPTED", "### ATTEMPTED", "## **ATTEMPTED**", "- ATTEMPTED:"
  const HEADER_RE = /^(?:#{1,4}\s+|-\s+)?\*{0,2}(ATTEMPTED|SUCCEEDED|FAILED|LEARNINGS|STRATEGIC_CONTEXT)\*{0,2}:?\*{0,2}:?\s*/;

  let currentSection: keyof EvolutionSections | "" = "";
  for (const line of result.split("\n")) {
    const trimmed = line.trim();
    const m = HEADER_RE.exec(trimmed);
    if (m) {
      currentSection = SECTION_MAP[m[1]];
      const rest = trimmed.slice(m[0].length);
      if (rest) sections[currentSection] += rest + "\n";
    } else if (currentSection) {
      sections[currentSection] += line + "\n";
    }
  }

  // Trim trailing whitespace from every section
  for (const key of Object.keys(sections) as Array<keyof EvolutionSections>) {
    sections[key] = sections[key].trim();
  }

  return sections;
}

/**
 * Count the number of improvement items in a section text.
 * Counts lines starting with "- ", "* ", or numbered items like "1. ", "2. ", "1) ".
 * Also counts inline numbered items (e.g., "1) foo. 2) bar. 3) baz" on one line).
 */
export function countImprovements(text: string): number {
  if (!text) return 0;

  // Split once and reuse for both the line count loop and nonEmptyLines check.
  const lines = text.split("\n");

  // Count lines starting with "- ", "* ", "N. ", or "N) "
  let lineCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.match(/^(?:[-*]\s|\d+[.)]\s)/)) {
      lineCount++;
    }
  }

  // Also count all numbered items throughout text (catches inline "1) foo. 2) bar")
  const inlineMatches = text.match(/(?:^|[\s,;(])\d+[.)]\s/gm);
  const inlineCount = inlineMatches ? inlineMatches.length : 0;

  // On multi-line input where the line-based scan found items, prefer lineCount.
  // This prevents prose references like "item 2) matters" from inflating the total.
  // For single-line input (e.g., "1) foo. 2) bar. 3) baz"), fall back to Math.max
  // so inline-only formats are still counted correctly.
  const nonEmptyLines = lines.filter((l) => l.trim()).length;
  if (lineCount > 0 && nonEmptyLines > 1) {
    return lineCount;
  }
  return Math.max(lineCount, inlineCount);
}

export function buildEvolutionPrompt(assessment: string, context?: EvolutionPromptContext): string {
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
2. After each change: \`pnpm build && pnpm test\` — if PASS commit with a descriptive message; if FAIL revert with \`git checkout .\` and continue.
3. NEVER modify IDENTITY.md.
4. Do NOT write to JOURNAL.md — journal entries are now stored in SQLite and managed by the orchestrator.
5. Keep changes small and incremental.
6. Update README.md and other public-facing documentation if needed.

After all improvements, end your response with a structured summary using EXACTLY this format (no markdown headers, no bold, just the marker followed by a colon and bullet-list items):

ATTEMPTED:
- <each improvement attempted, one bullet per line>
SUCCEEDED:
- <each improvement that passed build+test and was committed, one bullet per line>
FAILED:
- <each improvement that was reverted or skipped, or "none" if all succeeded>
LEARNINGS:
- [category] insight one, one bullet per line
- [category] insight two
STRATEGIC_CONTEXT: <2-4 sentences about your current focus areas, trajectory, and ongoing goals>`;
}
