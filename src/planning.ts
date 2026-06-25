import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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

/**
 * Canonical ordered list of all status columns in display order.
 * Exported so callers can iterate or validate against the authoritative
 * list without reconstructing it from individual STATUS_* constants.
 */
export const STATUS_COLUMNS = ["Backlog", "Up Next", "In Progress", "Done"] as const;

/**
 * Canonical string for the "In Progress" status column.
 * Exported so callers (e.g. context.ts) can reference it without repeating
 * the bare string literal and risking silent divergence from the source of truth.
 */
export const STATUS_IN_PROGRESS = "In Progress" as const satisfies StatusColumn;

/**
 * Canonical string for the "Up Next" status column.
 * Exported so callers can reference it without bare string literals.
 */
export const STATUS_UP_NEXT = "Up Next" as const satisfies StatusColumn;

/**
 * Canonical string for the "Done" status column.
 * Exported so callers can reference it without bare string literals.
 */
export const STATUS_DONE = "Done" as const satisfies StatusColumn;

/**
 * Canonical string for the "Backlog" status column.
 * Completes the set of exported status constants alongside STATUS_IN_PROGRESS,
 * STATUS_UP_NEXT, and STATUS_DONE so every StatusColumn value has a typed
 * constant and bare string drift is eliminated everywhere.
 */
export const STATUS_BACKLOG = "Backlog" as const satisfies StatusColumn;

/**
 * The canonical H1 header written at the top of every ROADMAP.md file.
 * Exported so tests can pin its value and callers can reference it without
 * relying on a hard-coded string literal.
 */
export const ROADMAP_HEADER = "# Bloom Evolution Roadmap";

/**
 * Maximum number of characters stored for an item body.
 * Bodies exceeding this limit are silently truncated — a console.warn is
 * emitted so callers can diagnose data loss without crashing the cycle.
 */
export const ITEM_BODY_LIMIT = 500;

/**
 * Maximum number of characters from a current-focus item body shown in the
 * planning context prompt. Kept intentionally short to avoid bloating prompts.
 */
export const PLANNING_BODY_PREVIEW_CHARS = 200;

/**
 * Default maximum total characters for the formatted planning context string
 * returned by formatPlanningContext. Truncation is applied at a newline boundary
 * to avoid cutting mid-line.
 */
export const PLANNING_CONTEXT_MAX_CHARS = 1200;

/**
 * Default maximum number of items rendered per status section in the planning
 * context (e.g. Backlog, Up Next). Prevents the prompt from growing unbounded
 * when many items share the same status.
 */
export const PLANNING_CONTEXT_MAX_ITEMS = 5;

/**
 * Default number of cycles an item may remain "In Progress" before it is
 * considered stale and demoted back to "Up Next". Items stuck for more than
 * this many cycles (i.e. currentCycle - sinceCycle > threshold) are flagged
 * by detectStaleInProgressItems and demoted by demoteStaleInProgressItems.
 */
export const STALE_IN_PROGRESS_THRESHOLD_CYCLES = 3;

export type StatusColumn = (typeof STATUS_COLUMNS)[number];

/**
 * Truncate a string to `max` characters for display, appending a `…` ellipsis
 * when truncation occurs. The condition is strictly `> max`, so strings of
 * exactly `max` characters are returned verbatim with no ellipsis.
 * Used for display-only previews in CLI output and LLM prompts.
 */
export function truncateWithEllipsis(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * Truncate a body string to ITEM_BODY_LIMIT characters, emitting a warning
 * when truncation occurs. The `tag` label is included in the warning message
 * for easy identification (e.g. "addLinkedItem #42" or "addDraftItem \"Title\"").
 */
function truncateItemBody(tag: string, body: string): string {
  if (body.length <= ITEM_BODY_LIMIT) return body;
  console.warn(`[planning] ${tag}: body truncated from ${body.length} to ${ITEM_BODY_LIMIT} chars`);
  return body.slice(0, ITEM_BODY_LIMIT) + " \u2026[truncated]";
}

// --- Roadmap File I/O ---

function getRoadmapPath(): string {
  return resolve(process.cwd(), ROADMAP_FILE);
}

export function readRoadmap(filePath?: string): string {
  const p = filePath ?? getRoadmapPath();
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

  // Normalise CRLF → LF so Windows-style line endings (e.g. from git
  // checkouts with core.autocrlf=true) do not leave a trailing \r on each
  // line and corrupt item titles, status headings, and body text.
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
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

    // Match item lines: - [ ] Title (#3) or - [x] Title or - [X] Title (GitHub renders both)
    const itemMatch = line.match(
      /^-\s+\[[ xX]\]\s+(.+)$/,
    );
    if (itemMatch) {
      if (!currentStatus) {
        console.warn(`[planning] parseRoadmap: item line found before any ## heading — ignoring: "${line.trim()}"`);
      } else {
        // Flush previous item
        if (currentItem?.title) {
          items.push(finalizeItem(currentItem, idCounter++));
        }
        const raw = itemMatch[1];
        const issueMatch = raw.match(/\(#(\d+)\)\s*$/);
        const linkedIssueNumber = issueMatch ? parseInt(issueMatch[1], 10) : null;
        const title = issueMatch ? raw.replace(/\s*\(#\d+\)\s*$/, "").trim() : raw.trim();

        currentItem = {
          title,
          status: currentStatus,
          body: "",
          linkedIssueNumber,
          reactions: 0,
        };
        continue;
      }
    }

    // Body lines (indented under an item)
    if (currentItem && line.match(/^\s+/) && line.trim()) {
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
  const lines: string[] = [ROADMAP_HEADER, ""];

  for (const status of STATUS_COLUMNS) {
    const statusItems = items.filter((i) => i.status === status);
    lines.push(`## ${status}`);
    if (statusItems.length === 0) {
      lines.push("");
      continue;
    }
    for (const item of statusItems) {
      const check = status === STATUS_DONE ? "x" : " ";
      const issueRef = item.linkedIssueNumber
        ? ` (#${item.linkedIssueNumber})`
        : "";
      lines.push(`- [${check}] ${item.title}${issueRef}`);
      if (item.body) {
        for (const bodyLine of item.body.replace(/\r\n/g, "\n").split("\n")) {
          // Skip blank/whitespace-only lines to match parseRoadmap's behaviour:
          // parseRoadmap drops lines where `line.trim()` is empty, so emitting
          // "  " (two spaces) for a blank body line creates a parse→serialize
          // round-trip inconsistency where the blank line silently disappears.
          if (bodyLine.trim()) {
            lines.push(`  ${bodyLine}`);
          }
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
 * Generate the next unique item ID by finding the highest existing `item-N`
 * index across all items and returning `item-(N+1)`.
 *
 * Items whose IDs do not match the canonical `item-N` format are ignored.
 * When `items` is empty or contains no standard-format IDs, returns `item-0`.
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
 * passes them to `fn` along with a `markDirty` callback, then serializes and
 * writes back only when `markDirty()` was called. Returns whatever `fn` returns.
 * This deduplicates the boilerplate shared by all CRUD operations.
 */
function withRoadmapItems<T>(filePath: string, fn: (items: ProjectItem[], markDirty: () => void) => T): T {
  const content = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
  const items = parseRoadmap(content);
  let dirty = false;
  const markDirty = () => { dirty = true; };
  const result = fn(items, markDirty);
  if (dirty) {
    writeFileSync(filePath, serializeRoadmap(items), "utf-8");
  }
  return result;
}

/**
 * Get all items from the roadmap file.
 */
export function getProjectItems(
  config: ProjectConfig,
): ProjectItem[] {
  const filePath = resolve(process.cwd(), config.filePath);
  return withRoadmapItems(filePath, (items) => [...items]);
}

/**
 * Private helper: push `newItem` onto `items` and call `markDirty()` only when
 * `isDuplicate` returns false for every existing item. Returns the id of the
 * surviving item (either the existing duplicate or the newly added one).
 * Centralises the "check → construct → push → mark" pattern shared by
 * addLinkedItem and addDraftItem so that future changes (e.g. to body
 * truncation or field defaults) only need to be made in one place.
 */
function addItemIfAbsent(
  items: ProjectItem[],
  markDirty: () => void,
  newItem: ProjectItem,
  isDuplicate: (existing: ProjectItem) => boolean,
): string {
  const existing = items.find(isDuplicate);
  if (existing) return existing.id;
  items.push(newItem);
  markDirty();
  return newItem.id;
}

/**
 * Add a linked GitHub issue to the roadmap.
 */
export function addLinkedItem(
  config: ProjectConfig,
  issueNumber: number,
  title: string,
  body: string,
  status: StatusColumn = STATUS_BACKLOG,
): string {
  const filePath = resolve(process.cwd(), config.filePath);
  return withRoadmapItems(filePath, (items, markDirty) => {
    const newItem: ProjectItem = {
      id: nextItemId(items),
      title,
      status,
      body: truncateItemBody(`addLinkedItem #${issueNumber}`, body.replace(/\r\n/g, "\n")),
      linkedIssueNumber: issueNumber,
      reactions: 0,
    };
    return addItemIfAbsent(items, markDirty, newItem, (i) => i.linkedIssueNumber === issueNumber);
  });
}

/**
 * Add a draft item (no linked issue) to the roadmap.
 */
export function addDraftItem(
  config: ProjectConfig,
  title: string,
  body: string,
  status: StatusColumn = STATUS_BACKLOG,
): string {
  const filePath = resolve(process.cwd(), config.filePath);
  return withRoadmapItems(filePath, (items, markDirty) => {
    const newItem: ProjectItem = {
      id: nextItemId(items),
      title,
      status,
      body: truncateItemBody(`addDraftItem "${title}"`, body.replace(/\r\n/g, "\n")),
      linkedIssueNumber: null,
      reactions: 0,
    };
    // Deduplication is case- and whitespace-insensitive for draft items
    const normalised = title.toLowerCase().trim();
    return addItemIfAbsent(items, markDirty, newItem, (i) => i.title.toLowerCase().trim() === normalised);
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
  config: ProjectConfig,
  itemId: string,
  status: StatusColumn,
  completionNote?: string,
  sinceCycle?: number,
): boolean {
  const filePath = resolve(process.cwd(), config.filePath);
  return withRoadmapItems(filePath, (items, markDirty) => {
    const item = items.find((i) => i.id === itemId);
    if (!item) return false;

    const oldStatus = item.status;
    const oldBody = item.body;

    item.status = status;
    if (status === STATUS_DONE && completionNote) {
      item.body = truncateItemBody("updateItemStatus Done", completionNote.replace(/\r\n/g, "\n"));
    } else if (status === STATUS_IN_PROGRESS && sinceCycle !== undefined && sinceCycle > 0) {
      // Preserve an existing [since: N] annotation so the staleness clock isn't
      // reset every cycle. Only stamp a new annotation when none is present yet
      // (i.e., the item is freshly transitioning into In Progress).
      // Guard sinceCycle > 0 to mirror parseInProgressSinceCycle's validation:
      // a zero or negative cycle number would produce a [since: 0] annotation
      // that stale detection treats as always-stale immediately.
      const existingAnnotation = item.body.match(/\[since:\s*\d+\]/);
      if (!existingAnnotation) {
        const stripped = stripSinceAnnotation(item.body).trim();
        item.body = stripped
          ? `${stripped}\n[since: ${sinceCycle}]`
          : `[since: ${sinceCycle}]`;
      }
    } else if (status !== STATUS_IN_PROGRESS) {
      // Strip any [since: N] annotation when leaving In Progress — it is no
      // longer meaningful and would leave stale staleness metadata in the body.
      item.body = stripSinceAnnotation(item.body).trim();
    }

    if (item.status !== oldStatus || item.body !== oldBody) markDirty();
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
 * Remove all [since: N] staleness annotations from a body string.
 * The preceding newline (if present) is consumed along with the annotation
 * so callers get a clean result without a dangling blank line.
 */
function stripSinceAnnotation(body: string): string {
  return body.replace(/\n?\[since:\s*\d+\]/g, "");
}

/**
 * Strip internal storage metadata from an item body for display purposes.
 * Removes [since: N] staleness annotations and …[truncated] storage markers
 * so the cleaned body is suitable for human-readable output and LLM prompts.
 */
export function cleanItemBody(body: string): string {
  body = body.replace(/\r\n/g, "\n");
  return stripSinceAnnotation(body)
    .replace(/ …\[truncated\]$/, "")
    .trim();
}

/**
 * Detect "In Progress" items that are stale — stuck without progress for
 * more than `threshold` cycles. Items without a [since: N] annotation are
 * always considered stale (they predate this feature or were orphaned by a crash).
 */
export function detectStaleInProgressItems(
  items: ProjectItem[],
  currentCycle: number,
  threshold: number = STALE_IN_PROGRESS_THRESHOLD_CYCLES,
): ProjectItem[] {
  return items.filter((item) => {
    if (item.status !== STATUS_IN_PROGRESS) return false;
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
  config: ProjectConfig,
  currentCycle: number,
  threshold: number = STALE_IN_PROGRESS_THRESHOLD_CYCLES,
): string[] {
  const filePath = resolve(process.cwd(), config.filePath);
  return withRoadmapItems(filePath, (items, markDirty) => {
    const stale = detectStaleInProgressItems(items, currentCycle, threshold);
    for (const item of stale) {
      item.status = STATUS_UP_NEXT;
      item.body = stripSinceAnnotation(item.body).trim();
    }
    if (stale.length > 0) markDirty();
    return stale.map((i) => i.title);
  });
}

// --- Planning Logic ---

/**
 * Result type returned by pickNextItemWithRationale.
 * `item` is the chosen ProjectItem (null when no actionable items exist).
 * `rationale` is a human-readable explanation of why this item was chosen,
 * e.g. "resumed In Progress item" / "promoted Up Next item" / "selected Backlog item".
 * Both fields are null together when the roadmap has no actionable items.
 */
export interface PickNextItemResult {
  item: ProjectItem | null;
  rationale: string | null;
}

/**
 * Pick the highest-priority item to work on this cycle and explain why.
 * Priority: "In Progress" first (resume unfinished work), then "Up Next", then "Backlog".
 * Within each status, items are ranked by reactions (descending) then by item ID (ascending).
 * Returns both the chosen item and a short rationale string suitable for display in
 * `pnpm stats --verbose` output so planning decisions are auditable cycle-to-cycle.
 */
export function pickNextItemWithRationale(items: ProjectItem[]): PickNextItemResult {
  const statusPriority = [STATUS_IN_PROGRESS, STATUS_UP_NEXT, STATUS_BACKLOG] as const;
  for (const status of statusPriority) {
    const candidates = items
      .filter((i) => i.status === status)
      .sort((a, b) => {
        const rxDiff = b.reactions - a.reactions;
        if (rxDiff !== 0) return rxDiff;
        // Guard against NaN: only use numeric comparison when both IDs match
        // the canonical item-N format; fall back to stable string comparison
        // for non-standard IDs so the sort remains deterministic.
        const aMatch = a.id.match(/^item-(\d+)$/);
        const bMatch = b.id.match(/^item-(\d+)$/);
        if (aMatch && bMatch) {
          return parseInt(aMatch[1], 10) - parseInt(bMatch[1], 10);
        }
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    if (candidates.length > 0) {
      const item = candidates[0];
      let rationale: string;
      if (status === STATUS_IN_PROGRESS) {
        rationale = `resumed In Progress item "${item.title}"`;
      } else if (status === STATUS_UP_NEXT) {
        rationale = `promoted Up Next item "${item.title}"`;
      } else {
        rationale = `selected Backlog item "${item.title}"`;
      }
      return { item, rationale };
    }
  }
  return { item: null, rationale: null };
}

/**
 * Pick the highest-priority item to work on this cycle.
 * Priority: "In Progress" first (resume unfinished work), then "Up Next", then "Backlog".
 * Delegates to pickNextItemWithRationale and discards the rationale.
 */
export function pickNextItem(items: ProjectItem[]): ProjectItem | null {
  return pickNextItemWithRationale(items).item;
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
  maxChars: number = PLANNING_CONTEXT_MAX_CHARS,
  maxItemsPerSection: number = PLANNING_CONTEXT_MAX_ITEMS,
): string {
  if (items.length === 0 && !currentItem) return "";

  // When all items are Done, non-Done filtering below yields no sections.
  // Return "" here so callers get a reliably empty string rather than a
  // dangling "## Evolution Roadmap" header with no actionable content.
  const hasNonDone = items.some((i) => i.status !== STATUS_DONE);
  if (!hasNonDone && !currentItem) return "";

  const lines: string[] = ["## Evolution Roadmap"];

  if (currentItem) {
    lines.push(`\n**Current focus**: ${currentItem.title}`);
    if (currentItem.body) {
      const cleanBody = cleanItemBody(currentItem.body);
      if (cleanBody) {
        const bodyPreview = truncateWithEllipsis(cleanBody, PLANNING_BODY_PREVIEW_CHARS);
        lines.push(bodyPreview);
      }
    }
  }

  for (const status of STATUS_COLUMNS) {
    if (status === STATUS_DONE) continue;
    // Filter out currentItem from the In Progress section — it's already rendered above
    const statusItems = items
      .filter((i) => i.status === status)
      .filter((i) => i !== currentItem)
      .sort((a, b) => b.reactions - a.reactions || a.id.localeCompare(b.id));
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
    const hiddenCount = statusItems.length - maxItemsPerSection;
    if (hiddenCount > 0) {
      lines.push(`- ... and ${hiddenCount} more`);
    }
  }

  const result = lines.join("\n");
  if (result.length <= maxChars) return result;
  const truncated = result.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf("\n");
  return (lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated) + "\n...";
}
