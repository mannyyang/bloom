import type Database from "better-sqlite3";
import {
  insertLearning,
  getRelevantLearnings,
  decayLearningRelevance,
  pruneLowRelevanceLearnings,
  insertStrategicContext,
  getLatestStrategicContext,
  pruneStrategicContext,
  type Learning,
} from "./db.js";

// --- Learning Categories ---
export const LEARNING_CATEGORIES = [
  "pattern",
  "anti-pattern",
  "domain",
  "tool-usage",
  "process",
] as const;

export type LearningCategory = (typeof LEARNING_CATEGORIES)[number];

// --- Extraction from evolution results ---

export interface ExtractedLearnings {
  learnings: Array<{ category: LearningCategory; content: string }>;
}

/**
 * Parse the LEARNINGS section from evolution results into categorized learnings.
 * Looks for category prefixes like [pattern], [anti-pattern], etc.
 * Falls back to "domain" if no category prefix is found.
 */
export function extractLearnings(learningsText: string): ExtractedLearnings {
  if (!learningsText || !learningsText.trim()) return { learnings: [] };

  const result: ExtractedLearnings = { learnings: [] };
  for (const line of learningsText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !/^[-*\d]/.test(trimmed)) continue;

    // Strip leading "- " or "* " or "1. " or "1) " etc.
    const content = trimmed.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "");
    if (!content) continue;

    // Check for [category] prefix
    const categoryMatch = content.match(/^\[([\w-]+)\]\s*(.*)/);
    let category: LearningCategory = "domain";
    let cleanContent = content;

    if (categoryMatch) {
      const candidate = categoryMatch[1];
      // Always strip the bracket tag from cleanContent regardless of whether
      // the category is recognised.
      cleanContent = categoryMatch[2];
      if (candidate && (LEARNING_CATEGORIES as readonly string[]).includes(candidate)) {
        category = candidate as LearningCategory;
      } else if (candidate) {
        console.warn(`[memory] extractLearnings: unrecognized category "[${candidate}]", falling back to "domain"`);
      }
    }

    if (cleanContent.trim()) {
      result.learnings.push({ category, content: cleanContent.trim() });
    }
  }

  return result;
}

/**
 * Result of storing extracted learnings.
 * `count` is the number of new (non-duplicate) learnings stored.
 * `dedupSkipped` is the count of learnings where the DB dedup lookup failed
 * due to a transient IO error — the learning was treated as new and stored
 * anyway to keep the cycle alive, but may be a duplicate.
 */
export interface StoreLearningsResult {
  count: number;
  dedupSkipped: number;
}

/**
 * Store extracted learnings in the database.
 * Applies relevance decay to existing learnings so newer ones rank higher.
 * Returns a StoreLearningsResult with the count of new learnings stored
 * and a dedupSkipped counter tracking IO-error dedup bypasses.
 */
export function storeLearnings(
  db: Database.Database,
  cycleNumber: number,
  extracted: ExtractedLearnings,
): StoreLearningsResult {
  if (extracted.learnings.length === 0) return { count: 0, dedupSkipped: 0 };
  const exists = db.prepare("SELECT 1 FROM learnings WHERE LOWER(TRIM(content)) = LOWER(TRIM(?)) LIMIT 1");
  // Deduplicate within the batch by normalised content before querying the DB,
  // so two identical learnings returned in the same cycle only count once.
  const seen = new Set<string>();
  let dedupSkipped = 0;
  const newLearnings = extracted.learnings
    .map(({ category, content }) => ({ category, content: content.trim() }))
    .filter(({ content }) => {
      if (!content) return false;
      const key = content.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      try {
        return !exists.get(content);
      } catch (err) {
        // Transient IO error (disk full, WAL corruption, locked DB) — treat
        // as new learning and skip dedup to keep the evolution cycle alive.
        dedupSkipped++;
        console.warn("[memory] storeLearnings: DB lookup failed, skipping dedup for this learning (non-fatal)", err);
        return true;
      }
    });
  if (newLearnings.length === 0) return { count: 0, dedupSkipped };
  decayLearningRelevance(db);
  pruneLowRelevanceLearnings(db);
  for (const { category, content } of newLearnings) {
    insertLearning(db, cycleNumber, category, content);
  }
  return { count: newLearnings.length, dedupSkipped };
}

// --- Strategic Context ---

/**
 * Number of recent cycles' worth of strategic context to retain.
 * Older entries are pruned after each insert to prevent unbounded table growth
 * while still preserving enough history for meaningful trend analysis.
 */
export const STRATEGIC_CONTEXT_RETENTION_CYCLES = 20;

/**
 * Store strategic context for a cycle.
 * Prunes old entries after inserting, keeping only the last
 * STRATEGIC_CONTEXT_RETENTION_CYCLES cycles' worth to prevent unbounded table
 * growth without losing meaningful recent history.
 */
export function storeStrategicContext(
  db: Database.Database,
  cycleNumber: number,
  context: string,
): void {
  insertStrategicContext(db, cycleNumber, context);
  pruneStrategicContext(db, STRATEGIC_CONTEXT_RETENTION_CYCLES);
}

// --- Formatting for Prompt Injection ---

/**
 * Maximum number of learnings fetched from the DB for prompt injection.
 * Ranked by relevance; excess entries are dropped before budget formatting.
 */
export const MAX_RELEVANT_LEARNINGS_TO_FETCH = 25;

/**
 * Default character budget for memory injected into the assessment prompt.
 * Keeps the context block small enough to avoid inflating token costs while
 * still providing meaningful learnings and strategic context.
 */
export const MAX_MEMORY_CHARS = 1200;

/** Markdown section header for the strategic context block in formatted memory output. */
export const MEMORY_STRATEGIC_CONTEXT_HEADER = "## Strategic Context\n";

/** Markdown section header for the key learnings block in formatted memory output. */
export const MEMORY_KEY_LEARNINGS_HEADER = "## Key Learnings\n";

/**
 * Format memory (learnings + strategic context) for inclusion in the assessment prompt.
 * Budget-aware: truncates content to fit within `maxChars`.
 *
 * **Truncation strategy (in priority order):**
 *
 * 1. **Strategic context first** — the latest strategic context is always included
 *    in its entirety, even if it alone exceeds `maxChars`. It is never budget-capped.
 *
 * 2. **Learnings by relevance** — learnings are fetched ranked by relevance
 *    (highest first) and appended category-by-category. A category header is only
 *    added to the output when at least one item from that category fits within the
 *    remaining budget (dangling headers with no items are never emitted).
 *
 * 3. **Line-boundary truncation** — each learning item is checked individually
 *    before appending. Truncation always stops on a clean `\n` boundary; the output
 *    never contains a mid-line cut.
 *
 * 4. **Ellipsis on truncation** — when the budget is exhausted mid-list, a `…\n`
 *    marker is appended (only if it fits within the remaining budget) so the LLM
 *    knows the list was cut and should not assume completeness.
 *
 * 5. **Separator accounting** — `sections.join("\n")` inserts a `\n` separator
 *    between the strategic context and learnings blocks; this separator is included
 *    in every budget check so `result.length <= maxChars` is an invariant
 *    (unless strategic context alone exceeds `maxChars` — see point 1).
 */
export function formatMemoryForPrompt(
  db: Database.Database,
  maxChars: number = MAX_MEMORY_CHARS,
): string {
  const sections: string[] = [];
  let totalLen = 0;

  // Strategic context first (most important)
  const strategic = getLatestStrategicContext(db);
  if (strategic) {
    const section = `${MEMORY_STRATEGIC_CONTEXT_HEADER}${strategic}\n`;
    sections.push(section);
    totalLen += section.length;
  }

  // Then learnings by category, ranked by relevance
  const learnings = getRelevantLearnings(db, MAX_RELEVANT_LEARNINGS_TO_FETCH);
  if (learnings.length > 0) {
    const grouped = new Map<string, Learning[]>();
    for (const l of learnings) {
      const list = grouped.get(l.category) ?? [];
      list.push(l);
      grouped.set(l.category, list);
    }

    // sections.join("\n") adds a "\n" separator before the learnings section when
    // a strategic-context section already exists; account for it in budget checks so
    // the final output never silently exceeds maxChars.
    const separatorLen = sections.length > 0 ? 1 : 0;

    const learningSectionHeader = MEMORY_KEY_LEARNINGS_HEADER;
    let learningSection = learningSectionHeader;
    let budgetExhausted = false;
    for (const category of LEARNING_CATEGORIES) {
      if (budgetExhausted) break;
      const items = grouped.get(category);
      if (!items || items.length === 0) continue;
      const header = `### ${category} (${items.length})\n`;
      const firstLine = `- ${items[0].content}\n`;
      // Require budget for both the category header AND its first item before
      // committing either to learningSection. This prevents a dangling header
      // with no items if the budget runs out immediately after the header.
      if (totalLen + separatorLen + learningSection.length + header.length + firstLine.length > maxChars) {
        budgetExhausted = true;
        break;
      }
      learningSection += header;
      for (const item of items) {
        const line = `- ${item.content}\n`;
        // Each item is checked individually; the ceiling is enforced here rather
        // than at loop entry so partial categories still contribute learnings.
        // separatorLen is included because join("\n") will insert it at output
        // time — omitting it would allow totalLen to silently exceed maxChars.
        if (totalLen + separatorLen + learningSection.length + line.length > maxChars) {
          budgetExhausted = true;
          break;
        }
        learningSection += line;
      }
    }
    // Only include the learnings section if it contains more than just the header
    if (learningSection.length > learningSectionHeader.length) {
      // When the budget was exhausted mid-list, append an ellipsis so the LLM
      // knows the learnings were cut and should not assume completeness.
      // The ellipsis is only appended when it fits within the remaining budget so
      // that the output length invariant (result.length <= maxChars) is preserved.
      if (budgetExhausted) {
        const ellipsis = "…\n";
        if (totalLen + separatorLen + learningSection.length + ellipsis.length <= maxChars) {
          learningSection += ellipsis;
        }
      }
      sections.push(learningSection);
    }
  }

  return sections.join("\n");
}
