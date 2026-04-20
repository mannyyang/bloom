import { readFileSync } from "fs";
import type Database from "better-sqlite3";
import { getRecentJournalSummary, getCycleStats, formatCycleStats } from "./db.js";
import { fetchCommunityIssues, syncReactionsToItems, type CommunityIssue } from "./issues.js";
import { triageIssues } from "./triage.js";
import { errorMessage } from "./errors.js";
import { formatMemoryForPrompt, MAX_MEMORY_CHARS } from "./memory.js";
import {
  ensureProject,
  getProjectItems,
  pickNextItem,
  updateItemStatus,
  demoteStaleInProgressItems,
  formatPlanningContext,
  type ProjectConfig,
  type ProjectItem,
} from "./planning.js";

/**
 * Maximum characters of journal history injected into the assessment prompt.
 * Keeps journal context concise while still covering recent cycles.
 */
export const CONTEXT_JOURNAL_MAX_CHARS = 1200;

/**
 * Maximum number of recent cycles included in the journal summary injected
 * into the assessment and evolution prompts.
 */
export const CONTEXT_JOURNAL_MAX_CYCLES = 2;

/**
 * Context gathered for the evolution cycle: identity, journal, issues,
 * memory, planning state, etc.
 */
export interface EvolutionContext {
  identity: string;
  journalSummary: string;
  cycleStatsText: string;
  memoryContext: string;
  planningContext: string;
  issues: CommunityIssue[];
  projectConfig: ProjectConfig | null;
  currentItem: ProjectItem | null;
}

/**
 * Load all context needed for the assessment and evolution phases.
 * Gathers identity, journal history, community issues, memory, and planning state.
 */
export async function loadEvolutionContext(
  db: Database.Database,
  cycleCount: number,
): Promise<EvolutionContext> {
  console.log("\n[context] Loading evolution context...");
  let identity: string;
  try {
    identity = readFileSync("IDENTITY.md", "utf-8");
  } catch (err) {
    throw new Error(`IDENTITY.md missing — cannot start cycle: ${errorMessage(err)}`);
  }
  console.log(`[context] Identity loaded (${identity.length} chars)`);

  const journalSummary = getRecentJournalSummary(db, CONTEXT_JOURNAL_MAX_CHARS, CONTEXT_JOURNAL_MAX_CYCLES);
  console.log(`[context] Journal summary: ${journalSummary ? `${journalSummary.length} chars` : "empty"}`);

  const cycleStats = getCycleStats(db);
  const cycleStatsText = formatCycleStats(cycleStats);
  console.log(`[context] Cycle stats: ${cycleStatsText ? `${cycleStatsText.length} chars` : "none"}`);

  // Memory context (best-effort)
  const memoryContext = formatMemoryForPrompt(db, MAX_MEMORY_CHARS);
  console.log(`[context] Memory context: ${memoryContext ? `${memoryContext.length} chars` : "empty"}`);

  // Fetch community issues; errors are non-fatal — fall back to an empty list
  // so a transient GitHub API failure does not abort the evolution cycle.
  let issues: CommunityIssue[] = [];
  try {
    issues = await fetchCommunityIssues();
  } catch (err) {
    console.error(`[context] Failed to fetch community issues (non-fatal): ${errorMessage(err)}`);
  }
  console.log(`[context] Community issues: ${issues.length} open`);
  for (const issue of issues) {
    console.log(`  - #${issue.number}: ${issue.title} (${issue.reactions} reactions)`);
  }

  // Planning context (best-effort, uses ROADMAP.md)
  let planningContext = "";
  let projectConfig: ProjectConfig | null = null;
  let currentItem: ProjectItem | null = null;
  try {
    console.log("[planning] Loading roadmap...");
    projectConfig = ensureProject();
    console.log(`[planning] Roadmap: ${projectConfig.filePath}`);
    let projectItems = getProjectItems(projectConfig);
    console.log(`[planning] ${projectItems.length} items on roadmap`);
    for (const item of projectItems) {
      console.log(`  - [${item.status ?? "No Status"}] ${item.title}${item.reactions > 0 ? ` (${item.reactions} reactions)` : ""}`);
    }

    // Triage community issues against the roadmap
    if (issues.length > 0) {
      console.log(`\n[triage] Triaging ${issues.length} community issues against roadmap...`);
      const triageResult = await triageIssues(issues, projectItems, cycleCount, projectConfig, db);
      if (triageResult.addedToBacklog.length > 0) {
        console.log(`[triage] Added to backlog: ${triageResult.addedToBacklog.map(n => `#${n}`).join(", ")}`);
      }
      if (triageResult.closed.length > 0) {
        console.log(`[triage] Closed: ${triageResult.closed.map(n => `#${n}`).join(", ")}`);
      }
      for (const d of triageResult.decisions) {
        console.log(`  - #${d.issueNumber}: ${d.action} — ${d.reason.slice(0, 100)}`);
      }
      // Re-fetch items since triage may have added new ones
      projectItems = getProjectItems(projectConfig);
      console.log(`[planning] ${projectItems.length} items on roadmap (post-triage)`);
    }

    // Sync +1 reactions from GitHub so prioritisation uses real community signal
    projectItems = await syncReactionsToItems(projectItems).catch((err: unknown) => {
      console.error(`[context] Failed to sync reactions (non-fatal): ${errorMessage(err)}`);
      return projectItems;
    });

    // Preserve live reaction data before potential re-fetch triggered by demotion.
    // getProjectItems reads from disk where reactions are always 0; without this
    // map the enriched counts from syncReactionsToItems would be silently dropped,
    // degrading community-driven prioritization after any demotion cycle.
    const reactionMap = new Map(projectItems.map((item) => [item.id, item.reactions]));

    // Demote any stale "In Progress" items before picking the next one.
    // Re-read from disk after the write so the in-memory view always matches
    // exactly what demoteStaleInProgressItems wrote, avoiding silent divergence
    // if that function's mutation logic ever changes.
    const demoted = demoteStaleInProgressItems(projectConfig, cycleCount);
    if (demoted.length > 0) {
      console.log(`[planning] Demoted ${demoted.length} stale In Progress item(s) back to Up Next: ${demoted.join(", ")}`);
      projectItems = getProjectItems(projectConfig);
      // Re-apply live reaction counts — the disk copy always has reactions=0.
      for (const item of projectItems) {
        const savedReactions = reactionMap.get(item.id);
        if (savedReactions !== undefined) {
          item.reactions = savedReactions;
        }
      }
    }

    currentItem = pickNextItem(projectItems);
    if (currentItem) {
      const markedInProgress = updateItemStatus(projectConfig, currentItem.id, "In Progress", undefined, cycleCount);
      if (markedInProgress) {
        console.log(`[planning] Selected: "${currentItem.title}" → marked In Progress (since cycle ${cycleCount})`);
      } else {
        console.error(`[planning] Could not mark "${currentItem.title}" In Progress — item not found in roadmap.`);
      }
    } else {
      console.log("[planning] No actionable items found");
    }
    planningContext = formatPlanningContext(projectItems, currentItem);
  } catch (err) {
    console.error(`[planning] Failed (non-fatal): ${errorMessage(err)}`);
  }

  return {
    identity,
    journalSummary,
    cycleStatsText,
    memoryContext,
    planningContext,
    issues,
    projectConfig,
    currentItem,
  };
}
