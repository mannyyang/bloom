import type Database from "better-sqlite3";
import {
  insertLearning,
  getRelevantLearnings,
  decayLearningRelevance,
  insertStrategicContext,
  getLatestStrategicContext,
  type Learning,
} from "./db.js";

// --- Learning Categories ---
export const LEARNING_CATEGORIES = [
  "pattern",
  "anti-pattern",
  "domain",
  "tool-usage",
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

    // Strip leading "- " or "* " or "1. " etc.
    const content = trimmed.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "");
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
      }
    }

    if (cleanContent.trim()) {
      result.learnings.push({ category, content: cleanContent.trim() });
    }
  }

  return result;
}

/**
 * Store extracted learnings in the database.
 * Applies relevance decay to existing learnings so newer ones rank higher.
 */
export function storeLearnings(
  db: Database.Database,
  cycleNumber: number,
  extracted: ExtractedLearnings,
): void {
  if (extracted.learnings.length === 0) return;
  decayLearningRelevance(db);
  for (const { category, content } of extracted.learnings) {
    insertLearning(db, cycleNumber, category, content);
  }
}

// --- Strategic Context ---

/**
 * Store strategic context for a cycle.
 */
export function storeStrategicContext(
  db: Database.Database,
  cycleNumber: number,
  context: string,
): void {
  insertStrategicContext(db, cycleNumber, context);
}

// --- Formatting for Prompt Injection ---

/**
 * Format memory (learnings + strategic context) for inclusion in the assessment prompt.
 * Budget-aware: truncates to fit within maxChars.
 */
export function formatMemoryForPrompt(
  db: Database.Database,
  maxChars: number = 2000,
): string {
  const sections: string[] = [];
  let totalLen = 0;

  // Strategic context first (most important)
  const strategic = getLatestStrategicContext(db);
  if (strategic) {
    const section = `## Strategic Context\n${strategic}\n`;
    sections.push(section);
    totalLen += section.length;
  }

  // Then learnings by category, ranked by relevance
  const learnings = getRelevantLearnings(db, 30);
  if (learnings.length > 0) {
    const grouped = new Map<string, Learning[]>();
    for (const l of learnings) {
      const list = grouped.get(l.category) ?? [];
      list.push(l);
      grouped.set(l.category, list);
    }

    const learningSectionHeader = "## Key Learnings\n";
    let learningSection = learningSectionHeader;
    let budgetExhausted = false;
    for (const [category, items] of grouped) {
      if (budgetExhausted) break;
      if (items.length === 0) continue;
      const header = `### ${category}\n`;
      const firstLine = `- ${items[0].content}\n`;
      // Require budget for both the header AND its first item before committing
      if (totalLen + learningSection.length + header.length + firstLine.length > maxChars) break;
      learningSection += header;
      for (const item of items) {
        const line = `- ${item.content}\n`;
        if (totalLen + learningSection.length + line.length > maxChars) {
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
