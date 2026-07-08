import { readdirSync } from "node:fs";
import { join } from "node:path";
import { CONTEXT_JOURNAL_MAX_CHARS } from "./context.js";
import { truncateWithEllipsis } from "./planning.js";

/** Maximum characters allowed for the assessment passed into the evolution prompt. */
export const ASSESSMENT_CHAR_LIMIT = 2000;

export interface AssessmentContext {
  journalSummary: string;
  cycleCount: number;
  cycleStatsText?: string;
  memoryContext?: string;
  planningContext?: string;
  /** Pre-built newline-joined list of src/**\/*.ts and tests/**\/*.ts paths.
   * When present, the LLM skips its own Glob calls to discover files,
   * saving assessment turns. */
  fileManifest?: string;
}

/**
 * Build a newline-joined list of *.ts files under src/ and tests/.
 * Returns an empty string if neither directory can be read.
 * Paths are relative to cwd (e.g. "src/evolve.ts", "tests/evolve.test.ts").
 */
export function buildFileManifest(cwd: string = process.cwd()): string {
  const dirs = ["src", "tests", "scripts"];
  const files: string[] = [];

  for (const dir of dirs) {
    try {
      // Node 18.17+ supports { recursive: true } in readdirSync
      const entries = readdirSync(join(cwd, dir), { recursive: true, encoding: "utf-8" }) as string[];
      for (const entry of entries) {
        if (entry.endsWith(".ts")) {
          // Normalise Windows separators to forward slashes for consistency
          files.push(`${dir}/${entry.replace(/\\/g, "/")}`);
        }
      }
    } catch {
      // Directory missing or unreadable — skip silently
    }
  }

  return files.sort().join("\n");
}

/**
 * Build the prompt for the assessment phase.
 * Note: `identity` is intentionally absent here — it is passed separately as
 * a systemPrompt to the SDK (see assess.ts and index.ts), so it does not need
 * to be embedded in the user-facing prompt text.
 */
export function buildAssessmentPrompt(ctx: AssessmentContext): string {
  const manifestSection = ctx.fileManifest
    ? `\nFile index (pre-built — no need to Glob src/, tests/, or scripts/):\n${ctx.fileManifest}\n`
    : "";

  return `This is evolution cycle ${ctx.cycleCount}.

Read src/, tests/, and scripts/, then list top 1-3 improvements (bugs, roadmap items, test gaps, clarity, new capabilities) — for each: what/why/difficulty. Keep your assessment under ${ASSESSMENT_CHAR_LIMIT} characters — it is passed directly into the implementation prompt.

Recent journal entries:
${truncateWithEllipsis(ctx.journalSummary, CONTEXT_JOURNAL_MAX_CHARS)}
${ctx.cycleStatsText ? `\nYour track record:\n${ctx.cycleStatsText}\n` : ""}${ctx.memoryContext ? `\nYour accumulated knowledge:\n${ctx.memoryContext}\n` : ""}${ctx.planningContext ? `\n${ctx.planningContext}\n` : ""}${manifestSection}`;
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
 * Matches structured summary section headers in evolution results.
 * Two alternatives handle all header formats and prevent false-positive section switches:
 *   Alt 1 — prefixed/bold headers (colon optional): "## ATTEMPTED", "- ATTEMPTED:",
 *            "**ATTEMPTED**:", "**ATTEMPTED:**", "## **ATTEMPTED**"
 *   Alt 2 — bare keyword (colon required): "ATTEMPTED:" — without a colon, a content
 *            line like "FAILED to compile X" inside LEARNINGS would silently hijack the
 *            active section; requiring the colon closes that gap.
 * Defined at module level to compile once rather than on each parseEvolutionResult call.
 */
const HEADER_RE = /^(?:(?:#{1,4}\s+|-\s+)\*{0,2}|\*{1,2})(ATTEMPTED|SUCCEEDED|FAILED|LEARNINGS|STRATEGIC_CONTEXT)\*{0,2}:?\*{0,2}:?\s*|^(ATTEMPTED|SUCCEEDED|FAILED|LEARNINGS|STRATEGIC_CONTEXT):\s*/;

/**
 * Matches list-item lines: "- item", "* item", "1. item", "1) item".
 * Compiled at module level so it is not recreated on every line of every countImprovements call.
 */
const LINE_LIST_RE = /^(?:[-*]\s|\d+[.)]\s)/;

/**
 * Matches inline numbered items like "1) foo" or "2. bar" anywhere in text.
 * The `g` and `m` flags return all occurrences when used with String.match().
 * Compiled at module level to avoid per-call regex construction; safe with match()
 * because match() always resets lastIndex before iterating a global regex.
 */
const INLINE_NUMBERED_RE = /(?:^|[\s,;(])\d+[.)]\s/gm;

/**
 * Parse the structured summary from an evolution result.
 * Extracts ATTEMPTED, SUCCEEDED, FAILED, LEARNINGS, and STRATEGIC_CONTEXT sections.
 */
export function parseEvolutionResult(result: string): EvolutionSections {
  result = result.replace(/\r\n/g, "\n");
  const sections: EvolutionSections = {
    attempted: "",
    succeeded: "",
    failed: "",
    learnings: "",
    strategic_context: "",
  };

  let currentSection: keyof EvolutionSections | "" = "";
  for (const line of result.split("\n")) {
    const trimmed = line.trim();
    const m = HEADER_RE.exec(trimmed);
    if (m) {
      const mapped = SECTION_MAP[m[1] ?? m[2]];
      if (!mapped) continue;
      currentSection = mapped;
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
 *
 * Dispatch logic (three branches, in priority order):
 *
 * (a) **Empty/falsy guard** — if `text` is empty, null, or undefined, returns 0
 *     immediately without attempting to split or scan.
 *
 * (b) **Multi-line branch** — when `lineCount > 0` AND the input has more than one
 *     non-empty line, returns `lineCount` directly and ignores `inlineCount`.
 *     This prevents prose back-references like "see item 2) above" from
 *     inflating the total on multi-line inputs.
 *
 * (c) **Single-line / zero-lineCount fallback** — for single-line inputs (e.g.
 *     "1) foo. 2) bar. 3) baz") or text where no line starts with a list marker,
 *     returns `Math.max(lineCount, inlineCount)` so inline-only formats are still
 *     counted correctly.
 */
export function countImprovements(text: string): number {
  if (!text) return 0;
  text = text.replace(/\r\n/g, "\n");

  // Split once and reuse for both the line count loop and nonEmptyLines check.
  const lines = text.split("\n");

  // Count lines starting with "- ", "* ", "N. ", or "N) "
  let lineCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (LINE_LIST_RE.test(trimmed)) {
      lineCount++;
    }
  }

  // Also count all numbered items throughout text (catches inline "1) foo. 2) bar")
  const inlineMatches = text.match(INLINE_NUMBERED_RE);
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

/**
 * Build the prompt sent to the evolution agent that implements improvements.
 *
 * @param assessment - The raw assessment text produced by the assessment phase.
 *   Truncated to {@link ASSESSMENT_CHAR_LIMIT} characters (with a console.warn)
 *   so that an oversized LLM response cannot inflate the evolution prompt beyond
 *   the limit communicated to the assessment agent. The truncation invariant is:
 *   exactly the first `ASSESSMENT_CHAR_LIMIT` characters are kept; no partial
 *   words are preserved at the boundary.
 * @param context - Optional sections injected between the assessment and the
 *   rules block. Both `usageContext` and `outcomeContext` are omitted when
 *   absent or empty-string so the prompt stays compact on the common path.
 * @returns A complete evolution prompt string ready to pass to the Claude agent.
 */
export function buildEvolutionPrompt(assessment: string, context?: EvolutionPromptContext): string {
  // Enforce the same character limit communicated to the assessment LLM so oversized
  // assessments cannot silently inflate the evolution prompt.
  let truncatedAssessment = assessment;
  if (assessment.length > ASSESSMENT_CHAR_LIMIT) {
    console.warn(
      `[evolve] Assessment truncated from ${assessment.length} to ${ASSESSMENT_CHAR_LIMIT} chars — some improvement items may have been dropped.`
    );
    truncatedAssessment = assessment.slice(0, ASSESSMENT_CHAR_LIMIT);
  }

  const usageSection = context?.usageContext
    ? `\n\nResource usage so far this cycle:\n${context.usageContext}`
    : "";

  const outcomeSection = context?.outcomeContext
    ? `\n\nCycle outcome metrics so far:\n${context.outcomeContext}`
    : "";

  return `Based on this assessment, implement the improvements.

${truncatedAssessment}${usageSection}${outcomeSection}

RULES:
1. Make ONE change at a time.
2. After each change: \`pnpm build && pnpm test\` — if PASS commit with a descriptive message; if FAIL revert with \`git checkout .\` (also manually delete any new untracked files you created) and continue.
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
