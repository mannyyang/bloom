import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

// --- Types ---

export interface ProjectItem {
  id: string;
  title: string;
  status: string | null;
  body: string;
  linkedIssueNumber: number | null;
  reactions: number;
}

export interface ProjectConfig {
  filePath: string;
}

// --- Constants ---

const ROADMAP_FILE = "ROADMAP.md";
const STATUS_COLUMNS = ["Backlog", "Up Next", "In Progress", "Done"] as const;
export type StatusColumn = (typeof STATUS_COLUMNS)[number];

// --- Roadmap File I/O ---

function getRoadmapPath(): string {
  return resolve(process.cwd(), ROADMAP_FILE);
}

function readRoadmap(): string {
  const p = getRoadmapPath();
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf-8");
}

function writeRoadmap(content: string): void {
  writeFileSync(getRoadmapPath(), content, "utf-8");
}

// --- Parsing ---

/**
 * Parse the ROADMAP.md file into ProjectItems.
 * Expected format:
 *
 * # Bloom Evolution Roadmap
 *
 * ## Backlog
 * - [ ] Item title (#3)
 *   Description text
 * - [ ] Another item
 *
 * ## Up Next
 * ...
 */
export function parseRoadmap(content: string): ProjectItem[] {
  const items: ProjectItem[] = [];
  let currentStatus: string | null = null;
  let currentItem: Partial<ProjectItem> | null = null;
  let idCounter = 0;

  for (const line of content.split("\n")) {
    // Match status headings
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      // Flush previous item
      if (currentItem?.title) {
        items.push(finalizeItem(currentItem, idCounter++));
      }
      currentItem = null;
      const heading = headingMatch[1].trim();
      currentStatus = STATUS_COLUMNS.includes(heading as StatusColumn)
        ? heading
        : null;
      continue;
    }

    // Match item lines: - [ ] Title (#3) or - [x] Title
    const itemMatch = line.match(
      /^-\s+\[[ x]\]\s+(.+)$/,
    );
    if (itemMatch && currentStatus) {
      // Flush previous item
      if (currentItem?.title) {
        items.push(finalizeItem(currentItem, idCounter++));
      }
      const raw = itemMatch[1];
      const issueMatch = raw.match(/\(#(\d+)\)\s*$/);
      const linkedIssueNumber = issueMatch ? parseInt(issueMatch[1], 10) : null;
      const title = issueMatch ? raw.replace(/\s*\(#\d+\)\s*$/, "") : raw;

      currentItem = {
        title,
        status: currentStatus,
        body: "",
        linkedIssueNumber,
        reactions: 0,
      };
      continue;
    }

    // Body lines (indented under an item)
    if (currentItem && line.match(/^\s{2,}/) && line.trim()) {
      currentItem.body = currentItem.body
        ? `${currentItem.body}\n${line.trim()}`
        : line.trim();
    }
  }

  // Flush last item
  if (currentItem?.title) {
    items.push(finalizeItem(currentItem, idCounter++));
  }

  return items;
}

function finalizeItem(partial: Partial<ProjectItem>, idx: number): ProjectItem {
  return {
    id: `item-${idx}`,
    title: partial.title ?? "",
    status: partial.status ?? null,
    body: partial.body ?? "",
    linkedIssueNumber: partial.linkedIssueNumber ?? null,
    reactions: partial.reactions ?? 0,
  };
}

// --- Serialization ---

/**
 * Serialize ProjectItems back into ROADMAP.md format.
 */
export function serializeRoadmap(items: ProjectItem[]): string {
  const lines: string[] = ["# Bloom Evolution Roadmap", ""];

  for (const status of STATUS_COLUMNS) {
    const statusItems = items.filter((i) => i.status === status);
    lines.push(`## ${status}`);
    if (statusItems.length === 0) {
      lines.push("");
      continue;
    }
    for (const item of statusItems) {
      const check = status === "Done" ? "x" : " ";
      const issueRef = item.linkedIssueNumber
        ? ` (#${item.linkedIssueNumber})`
        : "";
      lines.push(`- [${check}] ${item.title}${issueRef}`);
      if (item.body) {
        for (const bodyLine of item.body.split("\n")) {
          lines.push(`  ${bodyLine}`);
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

// --- Project Discovery/Creation ---

/**
 * Ensure the ROADMAP.md file exists, creating it with default structure if not.
 */
export function ensureProject(): ProjectConfig | null {
  const filePath = getRoadmapPath();
  if (!existsSync(filePath)) {
    writeRoadmap(serializeRoadmap([]));
  }
  return { filePath };
}

// --- ID Generation ---

/**
 * Compute the next unique item ID by scanning all existing IDs.
 * Uses max(numeric suffix) + 1 instead of items.length to avoid
 * ID collisions if items are ever removed or reordered.
 */
export function nextItemId(items: ProjectItem[]): string {
  let maxIndex = -1;
  for (const item of items) {
    const match = item.id.match(/^item-(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      if (idx > maxIndex) maxIndex = idx;
    }
  }
  return `item-${maxIndex + 1}`;
}

// --- Item CRUD ---

/**
 * Read-modify-write helper: reads the roadmap, parses items, passes them to
 * `fn`, then serializes and writes back. Returns whatever `fn` returns.
 * This deduplicates the boilerplate shared by all CRUD operations.
 */
function withRoadmapItems<T>(fn: (items: ProjectItem[]) => T): T {
  const items = parseRoadmap(readRoadmap());
  const before = JSON.stringify(items);
  const result = fn(items);
  const after = JSON.stringify(items);
  if (after !== before) {
    writeRoadmap(serializeRoadmap(items));
  }
  return result;
}

/**
 * Get all items from the roadmap file.
 */
export function getProjectItems(
  _config: ProjectConfig,
): ProjectItem[] {
  return parseRoadmap(readRoadmap());
}

/**
 * Add a linked GitHub issue to the roadmap.
 */
export function addLinkedItem(
  _config: ProjectConfig,
  _repo: string,
  issueNumber: number,
  title: string,
  body: string,
  status: StatusColumn = "Backlog",
): string | null {
  return withRoadmapItems((items) => {
    // Don't add duplicates
    if (items.some((i) => i.linkedIssueNumber === issueNumber)) {
      return items.find((i) => i.linkedIssueNumber === issueNumber)?.id ?? null;
    }

    const newItem: ProjectItem = {
      id: nextItemId(items),
      title,
      status,
      body: body.slice(0, 300),
      linkedIssueNumber: issueNumber,
      reactions: 0,
    };

    items.push(newItem);
    return newItem.id;
  });
}

/**
 * Add a draft item (no linked issue) to the roadmap.
 */
export function addDraftItem(
  _config: ProjectConfig,
  title: string,
  body: string,
  status: StatusColumn = "Backlog",
): string | null {
  return withRoadmapItems((items) => {
    // Don't add duplicates (match on title)
    const existing = items.find((i) => i.title === title);
    if (existing) return existing.id;

    const newItem: ProjectItem = {
      id: nextItemId(items),
      title,
      status,
      body: body.slice(0, 300),
      linkedIssueNumber: null,
      reactions: 0,
    };

    items.push(newItem);
    return newItem.id;
  });
}

/**
 * Update the status of an item by its ID.
 * When moving to "Done", an optional completionNote replaces the item body
 * to document what was accomplished.
 */
export function updateItemStatus(
  _config: ProjectConfig,
  itemId: string,
  status: StatusColumn,
  completionNote?: string,
): boolean {
  return withRoadmapItems((items) => {
    const item = items.find((i) => i.id === itemId);
    if (!item) return false;

    item.status = status;
    if (status === "Done" && completionNote) {
      item.body = completionNote;
    }
    return true;
  });
}

// --- Planning Logic ---

/**
 * Pick the highest-priority item to work on this cycle.
 * Priority: "In Progress" first (resume unfinished work), then "Up Next", then "Backlog".
 */
export function pickNextItem(items: ProjectItem[]): ProjectItem | null {
  const statusPriority = ["In Progress", "Up Next", "Backlog"] as const;
  for (const status of statusPriority) {
    const candidates = items
      .filter((i) => i.status === status)
      .sort((a, b) => b.reactions - a.reactions);
    if (candidates.length > 0) return candidates[0];
  }
  return null;
}

/**
 * Format project items for inclusion in the assessment prompt.
 */
export function formatPlanningContext(
  items: ProjectItem[],
  currentItem: ProjectItem | null,
  maxChars: number = 1500,
): string {
  if (items.length === 0 && !currentItem) return "";

  const lines: string[] = ["## Evolution Roadmap"];

  if (currentItem) {
    lines.push(`\n**Current focus**: ${currentItem.title}`);
    if (currentItem.body) {
      lines.push(currentItem.body.slice(0, 200));
    }
  }

  for (const status of STATUS_COLUMNS) {
    const statusItems = items.filter((i) => i.status === status);
    if (statusItems.length === 0) continue;

    lines.push(`\n### ${status}`);
    for (const item of statusItems.slice(0, 5)) {
      const reactions =
        item.reactions > 0 ? ` (${item.reactions} reactions)` : "";
      const issue = item.linkedIssueNumber
        ? ` [#${item.linkedIssueNumber}]`
        : "";
      lines.push(`- ${item.title}${issue}${reactions}`);
    }
  }

  const result = lines.join("\n");
  return result.length > maxChars ? result.slice(0, maxChars) + "\n..." : result;
}
