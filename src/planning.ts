import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

// --- Types ---

export interface ProjectItem {
  id: string;
  title: string;
  status: StatusColumn | null;
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

export function readRoadmap(): string {
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
  let currentStatus: StatusColumn | null = null;
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
        ? (heading as StatusColumn)
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
export function ensureProject(): ProjectConfig {
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
 * Read-modify-write helper: reads the roadmap at `filePath`, parses items,
 * passes them to `fn`, then serializes and writes back only if items changed.
 * Returns whatever `fn` returns.
 * This deduplicates the boilerplate shared by all CRUD operations.
 */
function withRoadmapItems<T>(filePath: string, fn: (items: ProjectItem[]) => T): T {
  const content = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
  const items = parseRoadmap(content);
  const before = JSON.stringify(items);
  const result = fn(items);
  const after = JSON.stringify(items);
  if (after !== before) {
    writeFileSync(filePath, serializeRoadmap(items), "utf-8");
  }
  return result;
}

/**
 * Get all items from the roadmap file.
 */
export function getProjectItems(
  _config: ProjectConfig,
): ProjectItem[] {
  const filePath = resolve(process.cwd(), _config.filePath);
  if (!existsSync(filePath)) return [];
  return parseRoadmap(readFileSync(filePath, "utf-8"));
}

/**
 * Add a linked GitHub issue to the roadmap.
 */
export function addLinkedItem(
  _config: ProjectConfig,
  issueNumber: number,
  title: string,
  body: string,
  status: StatusColumn = "Backlog",
): string {
  const filePath = resolve(process.cwd(), _config.filePath);
  return withRoadmapItems(filePath, (items) => {
    // Don't add duplicates
    const existing = items.find((i) => i.linkedIssueNumber === issueNumber);
    if (existing) return existing.id;

    const newItem: ProjectItem = {
      id: nextItemId(items),
      title,
      status,
      body: body.slice(0, 200),
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
): string {
  const filePath = resolve(process.cwd(), _config.filePath);
  return withRoadmapItems(filePath, (items) => {
    // Don't add duplicates (match on title)
    const existing = items.find((i) => i.title === title);
    if (existing) return existing.id;

    const newItem: ProjectItem = {
      id: nextItemId(items),
      title,
      status,
      body: body.slice(0, 200),
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
 * When moving to "In Progress", an optional sinceCycle stamps a [since: N]
 * annotation into the body so stale detection can identify stuck items.
 */
export function updateItemStatus(
  _config: ProjectConfig,
  itemId: string,
  status: StatusColumn,
  completionNote?: string,
  sinceCycle?: number,
): boolean {
  const filePath = resolve(process.cwd(), _config.filePath);
  return withRoadmapItems(filePath, (items) => {
    const item = items.find((i) => i.id === itemId);
    if (!item) return false;

    item.status = status;
    if (status === "Done" && completionNote) {
      item.body = completionNote;
    } else if (status === "In Progress" && sinceCycle !== undefined) {
      // Preserve an existing [since: N] annotation so the staleness clock isn't
      // reset every cycle. Only stamp a new annotation when none is present yet
      // (i.e., the item is freshly transitioning into In Progress).
      const existingAnnotation = item.body.match(/\[since:\s*\d+\]/);
      if (!existingAnnotation) {
        const stripped = item.body.replace(/\n?\[since:\s*\d+\]/g, "").trim();
        item.body = stripped
          ? `${stripped}\n[since: ${sinceCycle}]`
          : `[since: ${sinceCycle}]`;
      }
    }
    return true;
  });
}

// --- Stale Detection ---

/**
 * Parse the [since: N] annotation from an item body.
 * Returns the cycle number N, or null if no annotation is present.
 *
 * Validates that N is a positive integer. If an optional `currentCycle` is
 * provided, also rejects values where N > currentCycle (a future-cycle
 * annotation would silently disable stale detection by making the difference
 * negative, so we treat it as invalid and return null instead).
 */
export function parseInProgressSinceCycle(body: string, currentCycle?: number): number | null {
  const match = body.match(/\[since:\s*(\d+)\]/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  if (n <= 0) return null;
  if (currentCycle !== undefined && n > currentCycle) return null;
  return n;
}

/**
 * Detect "In Progress" items that are stale — stuck without progress for
 * more than `threshold` cycles. Items without a [since: N] annotation are
 * always considered stale (they predate this feature or were orphaned by a crash).
 */
export function detectStaleInProgressItems(
  items: ProjectItem[],
  currentCycle: number,
  threshold: number = 3,
): ProjectItem[] {
  return items.filter((item) => {
    if (item.status !== "In Progress") return false;
    const since = parseInProgressSinceCycle(item.body, currentCycle);
    if (since === null) return true; // no annotation (or invalid) → always stale
    return currentCycle - since > threshold;
  });
}

/**
 * Demote stale "In Progress" items back to "Up Next" and strip their
 * [since: N] annotation. Returns the titles of demoted items.
 */
export function demoteStaleInProgressItems(
  _config: ProjectConfig,
  currentCycle: number,
  threshold: number = 3,
): string[] {
  const filePath = resolve(process.cwd(), _config.filePath);
  return withRoadmapItems(filePath, (items) => {
    const stale = detectStaleInProgressItems(items, currentCycle, threshold);
    for (const item of stale) {
      item.status = "Up Next";
      item.body = item.body.replace(/\n?\[since:\s*\d+\]/g, "").trim();
    }
    return stale.map((i) => i.title);
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
      .sort((a, b) => {
        const rxDiff = b.reactions - a.reactions;
        if (rxDiff !== 0) return rxDiff;
        const aNum = parseInt(a.id.replace(/^item-/, ""), 10);
        const bNum = parseInt(b.id.replace(/^item-/, ""), 10);
        return aNum - bNum;
      });
    if (candidates.length > 0) return candidates[0];
  }
  return null;
}

/**
 * Format project items for inclusion in the assessment prompt.
 * Items are grouped by status (Backlog, Up Next, In Progress); Done items are
 * intentionally omitted to keep the prompt concise.  Items with a null status
 * (which cannot be produced by parseRoadmap but may be constructed directly)
 * are also excluded — callers should normalise status before passing items here.
 *
 * @param maxItemsPerSection - Maximum items shown per status section (default 5).
 *   Items beyond this cap are silently excluded before the `maxChars` budget is
 *   applied, so callers with a large roadmap may raise this if needed.
 */
export function formatPlanningContext(
  items: ProjectItem[],
  currentItem: ProjectItem | null,
  maxChars: number = 1200,
  maxItemsPerSection: number = 5,
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
    if (status === "Done") continue;
    // Filter out currentItem from the In Progress section — it's already rendered above
    const statusItems = items
      .filter((i) => i.status === status)
      .filter((i) => i !== currentItem);
    if (statusItems.length === 0) continue;

    lines.push(`\n### ${status}`);
    for (const item of statusItems.slice(0, maxItemsPerSection)) {
      const reactions =
        item.reactions > 0 ? ` (${item.reactions} reactions)` : "";
      const issue = item.linkedIssueNumber
        ? ` [#${item.linkedIssueNumber}]`
        : "";
      lines.push(`- ${item.title}${issue}${reactions}`);
    }
  }

  const result = lines.join("\n");
  if (result.length <= maxChars) return result;
  const truncated = result.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf("\n");
  return (lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated) + "\n...";
}
