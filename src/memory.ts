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
  if (!learningsText.trim()) return { learnings: [] };

  const result: ExtractedLearnings = { learnings: [] };
  for (const line of learningsText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.match(/^[-*\d]/)) continue;

    // Strip leading "- " or "* " or "1. " or "1) " etc.
    const content = trimmed.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "");
    if (!content) continue;

    // Check for [category] prefix
    const categoryMatch = content.match(/^\[([\w-]+)\]\s*(.*)/);
    let category: LearningCategory = "domain";
    let cleanContent = content;

    if (categoryMatch) {
      const candidate = categoryMatch[1];
      const remainder = categoryMatch[2];
      if (
        candidate &&
        (LEARNING_CATEGORIES as readonly string[]).includes(candidate)
      ) {
        category = candidate as LearningCategory;
        cleanContent = remainder ?? "";
      } else {
        // Unknown category prefix — strip the bracket tag but keep the text
        cleanContent = remainder ?? content;
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
      } catch {
        // Transient IO error (disk full, WAL corruption, locked DB) — treat
        // as new learning and skip dedup to keep the evolution cycle alive.
        dedupSkipped++;
        console.warn("[memory] storeLearnings: DB lookup failed, skipping dedup for this learning (non-fatal)");
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
 * Budget-aware: truncates to fit within maxChars.
 *
 * Strategic context is always included in its entirety; the per-category budget
 * applies only to the learnings section.
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
    for (const [category, items] of grouped) {
      if (budgetExhausted) break;
      if (items.length === 0) continue;
      const header = `### ${category}\n`;
      const firstLine = `- ${items[0].content}\n`;
      // Require budget for both the category header AND its first item before
      // committing either to learningSection. This prevents a dangling header
      // with no items if the budget runs out immediately after the header.
      if (totalLen + separatorLen + learningSection.length + header.length + firstLine.length > maxChars) break;
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
      sections.push(learningSection);
    }
  }

  return sections.join("\n");
}
