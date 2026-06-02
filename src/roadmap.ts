/**
 * CLI entry point for viewing Bloom's current evolution roadmap.
 * Reads ROADMAP.md and prints a formatted summary of all items by status.
 *
 * Usage: pnpm roadmap
 *
 * Mirrors the pattern of `pnpm stats` and `pnpm journal`, giving humans
 * a quick way to inspect planning state without reading raw Markdown.
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  parseRoadmap,
  parseInProgressSinceCycle,
  cleanItemBody,
  readRoadmap,
  STATUS_BACKLOG,
  STATUS_IN_PROGRESS,
  STATUS_UP_NEXT,
  STATUS_DONE,
  type StatusColumn,
  type ProjectItem,
} from "./planning.js";
import { parseJsonFlag } from "./stats.js";
import { CYCLE_SUMMARY_SEPARATOR } from "./db.js";

export const ROADMAP_BODY_PREVIEW_MAX_CHARS = 120;

const STATUS_ORDER: StatusColumn[] = [STATUS_IN_PROGRESS, STATUS_UP_NEXT, STATUS_BACKLOG, STATUS_DONE];

/**
 * Parse `--filter <status>` from an argv array, returning the matched StatusColumn
 * or undefined when the flag is absent, missing a value, or the value does not
 * match a known status (case-insensitive).
 *
 * Examples:
 *   --filter backlog   → "Backlog"
 *   --filter "in progress" → "In Progress"
 *   --filter done      → "Done"
 */
export function parseRoadmapFilterFlag(argv: string[]): StatusColumn | undefined {
  const idx = argv.indexOf("--filter");
  if (idx === -1) return undefined;
  const raw = argv[idx + 1];
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  return STATUS_ORDER.find(s => s.toLowerCase() === lower);
}

/**
 * Core roadmap display logic, accepting raw markdown for testability.
 * Returns the lines that would be printed to the console.
 * When `filterStatus` is provided, only items with that status are shown.
 */
export function generateRoadmapOutput(content: string, filterStatus?: StatusColumn): string[] {
  const items = parseRoadmap(content);
  const lines: string[] = [];

  lines.push("");
  lines.push(CYCLE_SUMMARY_SEPARATOR);
  lines.push("  Bloom Evolution Roadmap");
  lines.push(CYCLE_SUMMARY_SEPARATOR);

  const statusesToRender = filterStatus ? [filterStatus] : STATUS_ORDER;
  let anyRendered = false;
  for (const status of statusesToRender) {
    const statusItems = items.filter((i) => i.status === status);
    if (statusItems.length === 0) continue;

    anyRendered = true;
    lines.push("");
    lines.push(`  ${status.toUpperCase()}`);
    lines.push("  " + "-".repeat(status.length));

    for (const item of statusItems) {
      const issue = item.linkedIssueNumber ? ` (#${item.linkedIssueNumber})` : "";
      const reactions = item.reactions > 0 ? ` [${item.reactions} ★]` : "";
      const check = item.status === STATUS_DONE ? "✓" : "○";

      // Extract [since: N] staleness annotation for In Progress items and render
      // it as "(since cycle N)" on the title line so stuck work is immediately visible.
      let sinceLabel = "";
      if (item.status === STATUS_IN_PROGRESS && item.body) {
        const sinceCycle = parseInProgressSinceCycle(item.body);
        if (sinceCycle !== null) {
          sinceLabel = ` (since cycle ${sinceCycle})`;
        }
      }

      lines.push(`  ${check} ${item.title}${issue}${reactions}${sinceLabel}`);
      if (item.body) {
        // Strip internal [since: N] staleness annotations and …[truncated] storage
        // markers before display — these are planning metadata and should not appear
        // in human-readable output.
        const displayBody = cleanItemBody(item.body);
        if (displayBody) {
          // Indent and wrap the body description
          const preview = displayBody.length > ROADMAP_BODY_PREVIEW_MAX_CHARS ? displayBody.slice(0, ROADMAP_BODY_PREVIEW_MAX_CHARS) + "…" : displayBody;
          for (const bodyLine of preview.split("\n")) {
            lines.push(`      ${bodyLine}`);
          }
        }
      }
    }
  }

  if (!anyRendered) {
    lines.push("");
    lines.push("  No items on the roadmap yet.");
  }

  lines.push("");
  return lines;
}

/**
 * A cleaned-up view of a ProjectItem for machine-readable JSON output.
 * Storage metadata ([since: N] annotations and …[truncated] markers) are
 * stripped from body so CI dashboards see the same clean data shown in the
 * human-readable CLI output. sinceCycle is derived from the body annotation
 * for In Progress items and exposed as a typed field rather than an embedded string.
 */
export interface RoadmapJsonItem extends Omit<ProjectItem, "body"> {
  body: string;
  /**
   * The cycle number when this item entered "In Progress" status, as recorded
   * by the `[since: N]` annotation in the item body. Only populated for items
   * with `status === STATUS_IN_PROGRESS` that have a valid `[since: N]`
   * annotation in their stored body. Null for all other statuses, or when the
   * annotation is absent or malformed. Note: future-cycle values (N greater
   * than the current cycle) are propagated as-is because no currentCycle
   * context is available at JSON generation time.
   */
  sinceCycle: number | null;
}

/**
 * Summary metadata included in the machine-readable JSON output.
 * `total` is the count of ALL items, including any with a null status
 * (items whose section heading does not map to a known StatusColumn).
 * `byStatus` maps each known StatusColumn to its item count and only
 * includes non-null statuses — so `total` may exceed the sum of
 * `byStatus` values when null-status items are present.
 */
export interface RoadmapJsonSummary {
  total: number;
  byStatus: Partial<Record<StatusColumn, number>>;
}

/**
 * Machine-readable JSON output for CI automation, dashboards, and scripting.
 * Strips internal storage markers ([since: N], …[truncated]) from item bodies
 * and attaches sinceCycle so consumers get clean data matching the CLI display.
 * Items are sorted by STATUS_ORDER (same order as the CLI display) so output
 * is deterministic regardless of parse order.
 * Includes a `summary` field with total item count and per-status counts,
 * mirroring the `latestCycle` metadata pattern from generateStatsJson.
 * When `filterStatus` is provided, only items with that status are included in
 * the output and the summary reflects the filtered subset — matching the
 * behaviour of `generateRoadmapOutput` with a filterStatus argument.
 */
export function generateRoadmapJson(content: string, filterStatus?: StatusColumn): { items: RoadmapJsonItem[]; summary: RoadmapJsonSummary } {
  const items = parseRoadmap(content);
  let cleanItems: RoadmapJsonItem[] = items.map((item) => {
    const sinceCycle =
      item.status === STATUS_IN_PROGRESS && item.body
        ? parseInProgressSinceCycle(item.body)
        : null;
    const cleanBody = cleanItemBody(item.body);
    return { ...item, body: cleanBody, sinceCycle };
  });

  // Apply status filter before sorting/summary, mirroring generateRoadmapOutput.
  if (filterStatus !== undefined) {
    cleanItems = cleanItems.filter((item) => item.status === filterStatus);
  }

  // Sort items by STATUS_ORDER so JSON output matches CLI display order.
  // Items with an unrecognised/null status are placed last.
  const statusRank = new Map<string, number>(STATUS_ORDER.map((s, i) => [s, i]));
  cleanItems.sort((a, b) => {
    const ra = a.status !== null ? (statusRank.get(a.status) ?? STATUS_ORDER.length) : STATUS_ORDER.length;
    const rb = b.status !== null ? (statusRank.get(b.status) ?? STATUS_ORDER.length) : STATUS_ORDER.length;
    return ra - rb;
  });

  // Build summary: total count and per-status breakdown (reflects filtered subset).
  const byStatus: Partial<Record<StatusColumn, number>> = {};
  for (const item of cleanItems) {
    if (item.status !== null) {
      byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
    }
  }
  const summary: RoadmapJsonSummary = { total: cleanItems.length, byStatus };

  return { items: cleanItems, summary };
}

function main() {
  let content: string;
  try {
    content = readRoadmap();
  } catch (err) {
    console.error(`Roadmap unavailable: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const jsonMode = parseJsonFlag(process.argv);
  const filterStatus = parseRoadmapFilterFlag(process.argv);

  if (jsonMode) {
    const result = generateRoadmapJson(content, filterStatus);
    console.log(JSON.stringify(result, null, 2));
  } else {
    const output = generateRoadmapOutput(content, filterStatus);
    for (const line of output) {
      console.log(line);
    }
  }
}

// Only run when executed directly as a CLI script, not when imported
const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  main();
}
