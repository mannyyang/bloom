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
  truncateWithEllipsis,
  STATUS_BACKLOG,
  STATUS_IN_PROGRESS,
  STATUS_UP_NEXT,
  STATUS_DONE,
  type StatusColumn,
  type ProjectItem,
} from "./planning.js";
import { parseJsonFlag, parseHelpFlag, parseSearchArg, parseVerboseFlag, parseSinceArg } from "./stats.js";
import { csvQuoteField, filterBySearchTerm } from "./csv.js";
import { CYCLE_SUMMARY_SEPARATOR } from "./db.js";
import { errorMessage } from "./errors.js";

export const ROADMAP_BODY_PREVIEW_MAX_CHARS = 120;

/**
 * Usage text printed when `pnpm roadmap --help` is invoked.
 * Lists every supported flag with a short description, mirroring the
 * convention used by `pnpm stats --help`.
 */
export const ROADMAP_HELP_TEXT = `\
Usage: pnpm roadmap [options]

Options:
  --filter <status>  Show only items with the given status (e.g. Backlog, "In Progress", Done)
  --since <N>        Show only In Progress items that entered progress at cycle N or later
  --search <term>    Filter items by case-insensitive keyword search across title and body
  --format md        Output roadmap as GitHub-flavoured Markdown
  --format csv       Output roadmap as RFC 4180 CSV
  --verbose          Print full item descriptions without truncation
  --json             Output roadmap as JSON (for scripting/CI)
  --help, -h         Print this help message and exit
`;

export const STATUS_ORDER: StatusColumn[] = [STATUS_IN_PROGRESS, STATUS_UP_NEXT, STATUS_BACKLOG, STATUS_DONE];

/**
 * Filter a ProjectItem array by a minimum sinceCycle threshold.
 * Applies only to In Progress items: an item is excluded if it has a valid
 * [since: N] annotation and N < sinceCycle. Items without the annotation
 * (sinceCycle null) are always kept — silently hiding unannotated work would
 * be worse than showing too much.  Non-In Progress items are always kept.
 * Exported so tests can assert filtering behaviour in isolation.
 */
export function filterItemsBySinceCycle<T extends { status: StatusColumn | null; body: string }>(
  items: T[],
  sinceCycle: number,
): T[] {
  return items.filter((item) => {
    if (item.status !== STATUS_IN_PROGRESS) return true;
    const since = item.body ? parseInProgressSinceCycle(item.body) : null;
    return since === null || since >= sinceCycle;
  });
}

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
  const single = STATUS_ORDER.find(s => s.toLowerCase() === lower);
  if (single !== undefined) return single;
  // Fallback: try joining the next two tokens for multi-word statuses like
  // "Up Next" or "In Progress" that the shell may have split into two argv slots
  // (e.g. pnpm roadmap --filter up next without quoting).
  const next = argv[idx + 2];
  if (next) {
    const combined = (raw + " " + next).toLowerCase();
    return STATUS_ORDER.find(s => s.toLowerCase() === combined);
  }
  return undefined;
}

/**
 * Parse `--format <value>` from an argv array. Recognised values are `"md"`
 * (GitHub-flavoured Markdown) and `"csv"` (RFC 4180 CSV). Returns the matched
 * format string, or `undefined` when the flag is absent or the value is unknown.
 *
 * Examples:
 *   --format md  → "md"
 *   --format csv → "csv"
 */
export function parseFormatFlag(argv: string[]): "md" | "csv" | undefined {
  const idx = argv.indexOf("--format");
  if (idx === -1) return undefined;
  const val = argv[idx + 1];
  if (val === "md" || val === "csv") return val;
  return undefined;
}

/**
 * Parse `--search <term>` from an argv array. Returns the search string if
 * present and non-empty, or undefined when the flag is absent or has no value.
 *
 * Examples:
 *   --search csv   → "csv"
 *   (absent)       → undefined
 *
 * Delegates to the shared parseSearchArg utility from stats.ts so the
 * identical flag-parsing logic is not duplicated across CLI modules.
 */
export function parseRoadmapSearchFlag(argv: string[]): string | undefined {
  return parseSearchArg(argv);
}

/**
 * Serialize roadmap items as RFC 4180 CSV.
 * Columns: title, status, linkedIssueNumber, reactions, sinceCycle, body
 * The first row is a fixed header. An empty items array produces header-only output.
 * When `filterStatus` is provided, only items with that status are included.
 */
/**
 * Fixed header row for CSV output produced by generateRoadmapCsv.
 * Exported so tests can pin the schema and catch column-level regressions
 * without parsing generated output — mirrors the STATS_CSV_HEADER /
 * JOURNAL_CSV_HEADER convention in stats.ts and journal.ts.
 */
export const ROADMAP_CSV_HEADER = "title,status,linkedIssueNumber,reactions,sinceCycle,body";

export function generateRoadmapCsv(content: string, filterStatus?: StatusColumn, search?: string, sinceCycle?: number): string {
  const { items } = generateRoadmapJson(content, filterStatus, undefined, search, sinceCycle);
  const lines: string[] = [ROADMAP_CSV_HEADER];
  for (const item of items) {
    lines.push([
      csvQuoteField(item.title),
      csvQuoteField(item.status ?? ""),
      csvQuoteField(item.linkedIssueNumber != null ? String(item.linkedIssueNumber) : ""),
      csvQuoteField(String(item.reactions)),
      csvQuoteField(item.sinceCycle != null ? String(item.sinceCycle) : ""),
      csvQuoteField(item.body),
    ].join(","));
  }
  return lines.join("\n") + "\n";
}

/**
 * Render the roadmap as GitHub-flavoured Markdown suitable for embedding in
 * PRs, issues, and release notes without editing ROADMAP.md directly.
 *
 * Layout:
 *   # Bloom Evolution Roadmap
 *   ## In Progress
 *   - [ ] Title (#N) [R ★] (since cycle C)
 *     Body preview...
 *   ## Up Next
 *   - [ ] Title
 *   ## Done
 *   - [x] Title
 *
 * When `filterStatus` is provided, only the section for that status is emitted.
 * Storage metadata ([since: N] annotations and …[truncated] markers) are
 * stripped from item bodies — matching the behaviour of generateRoadmapOutput.
 */
export function generateRoadmapMarkdown(content: string, filterStatus?: StatusColumn, search?: string, sinceCycle?: number): string {
  let items = parseRoadmap(content);
  // Apply --search filter post-parse via shared csv.ts helper.
  items = filterBySearchTerm(items, search ?? "", (i) => [i.title, i.body]);
  // Apply --since filter: exclude In Progress items whose sinceCycle is below threshold.
  if (sinceCycle !== undefined) items = filterItemsBySinceCycle(items, sinceCycle);
  const lines: string[] = [];

  lines.push("# Bloom Evolution Roadmap");
  lines.push("");

  const statusesToRender = filterStatus ? [filterStatus] : STATUS_ORDER;
  let anyRendered = false;

  for (const status of statusesToRender) {
    const statusItems = items.filter((i) => i.status === status);
    if (statusItems.length === 0) continue;

    anyRendered = true;
    lines.push(`## ${status}`);
    lines.push("");

    for (const item of statusItems) {
      const checkbox = item.status === STATUS_DONE ? "[x]" : "[ ]";
      const issue = item.linkedIssueNumber ? ` (#${item.linkedIssueNumber})` : "";
      const reactions = item.reactions > 0 ? ` [${item.reactions} ★]` : "";

      let sinceLabel = "";
      if (item.status === STATUS_IN_PROGRESS && item.body) {
        const sinceCycle = parseInProgressSinceCycle(item.body);
        if (sinceCycle !== null) {
          sinceLabel = ` (since cycle ${sinceCycle})`;
        }
      }

      lines.push(`- ${checkbox} ${item.title}${issue}${reactions}${sinceLabel}`);

      if (item.body) {
        const displayBody = cleanItemBody(item.body);
        if (displayBody) {
          const preview = truncateWithEllipsis(displayBody, ROADMAP_BODY_PREVIEW_MAX_CHARS);
          for (const bodyLine of preview.split("\n")) {
            lines.push(`  ${bodyLine}`);
          }
        }
      }
    }

    lines.push("");
  }

  if (!anyRendered) {
    lines.push(
      filterStatus
        ? `_No ${filterStatus} items on the roadmap._`
        : "_No items on the roadmap yet._",
    );
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Core roadmap display logic, accepting raw markdown for testability.
 * Returns the lines that would be printed to the console.
 * When `filterStatus` is provided, only items with that status are shown.
 */
export function generateRoadmapOutput(content: string, filterStatus?: StatusColumn, search?: string, verbose?: boolean, sinceCycle?: number): string[] {
  let items = parseRoadmap(content);
  // Apply --search filter post-parse via shared csv.ts helper.
  items = filterBySearchTerm(items, search ?? "", (i) => [i.title, i.body]);
  // Apply --since filter: exclude In Progress items whose sinceCycle is below threshold.
  if (sinceCycle !== undefined) items = filterItemsBySinceCycle(items, sinceCycle);
  const lines: string[] = [];

  lines.push("");
  lines.push(CYCLE_SUMMARY_SEPARATOR);
  lines.push("  Bloom Evolution Roadmap");
  lines.push(CYCLE_SUMMARY_SEPARATOR);

  // Build a compact at-a-glance summary of item counts per status.
  // Only statuses that have at least one item are included so the summary
  // line never lists zeros.  When no items exist the summary is omitted
  // (the "No items on the roadmap yet." fallback covers that case).
  // When filterStatus is active, the summary reflects only the filtered
  // subset — consistent with generateRoadmapJson which does the same.
  const summaryItems = filterStatus ? items.filter(i => i.status === filterStatus) : items;
  const summaryParts: string[] = [];
  for (const status of STATUS_ORDER) {
    const count = summaryItems.filter(i => i.status === status).length;
    if (count > 0) summaryParts.push(`${count} ${status.toLowerCase()}`);
  }
  if (summaryParts.length > 0) {
    lines.push(`  Items: ${summaryParts.join(" · ")}`);
  }

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
          // Indent and wrap the body description; skip truncation in verbose mode.
          const preview = verbose ? displayBody : truncateWithEllipsis(displayBody, ROADMAP_BODY_PREVIEW_MAX_CHARS);
          for (const bodyLine of preview.split("\n")) {
            lines.push(`      ${bodyLine}`);
          }
        }
      }
    }
  }

  if (!anyRendered) {
    lines.push("");
    lines.push(
      filterStatus
        ? `  No ${filterStatus} items on the roadmap.`
        : "  No items on the roadmap yet.",
    );
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
   * annotation is absent or malformed. When `currentCycle` is passed to
   * `generateRoadmapJson`, future-cycle values (N > currentCycle) are rejected
   * and produce null, preventing phantom staleness clock resets.
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
export function generateRoadmapJson(content: string, filterStatus?: StatusColumn, currentCycle?: number, search?: string, sinceCycle?: number): { items: RoadmapJsonItem[]; summary: RoadmapJsonSummary } {
  const items = parseRoadmap(content);
  let cleanItems: RoadmapJsonItem[] = items.map((item) => {
    const itemSinceCycle =
      item.status === STATUS_IN_PROGRESS && item.body
        ? parseInProgressSinceCycle(item.body, currentCycle)
        : null;
    const cleanBody = cleanItemBody(item.body);
    return { ...item, body: cleanBody, sinceCycle: itemSinceCycle };
  });

  // Apply status filter before sorting/summary, mirroring generateRoadmapOutput.
  if (filterStatus !== undefined) {
    cleanItems = cleanItems.filter((item) => item.status === filterStatus);
  }

  // Apply --since filter: exclude In Progress items whose sinceCycle is below threshold.
  // Items with null sinceCycle (no annotation) pass through to avoid silent data loss.
  if (sinceCycle !== undefined) {
    cleanItems = cleanItems.filter((item) => {
      if (item.status !== STATUS_IN_PROGRESS) return true;
      return item.sinceCycle === null || item.sinceCycle >= sinceCycle;
    });
  }

  // Apply --search filter post-clean via shared csv.ts helper.
  cleanItems = filterBySearchTerm(cleanItems, search ?? "", (i) => [i.title, i.body]);

  // Sort items by STATUS_ORDER so JSON output matches CLI display order.
  // Items with an unrecognised/null status are placed last.
  // Secondary sort by title (localeCompare) breaks ties within the same status,
  // making JSON output fully deterministic regardless of parse order.
  const statusRank = new Map<string, number>(STATUS_ORDER.map((s, i) => [s, i]));
  cleanItems.sort((a, b) => {
    const ra = a.status !== null ? (statusRank.get(a.status) ?? STATUS_ORDER.length) : STATUS_ORDER.length;
    const rb = b.status !== null ? (statusRank.get(b.status) ?? STATUS_ORDER.length) : STATUS_ORDER.length;
    return ra - rb || a.title.localeCompare(b.title);
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
  if (parseHelpFlag(process.argv)) {
    process.stdout.write(ROADMAP_HELP_TEXT);
    return;
  }

  let content: string;
  try {
    content = readRoadmap();
  } catch (err) {
    console.error(`Roadmap unavailable: ${errorMessage(err)}`);
    process.exit(1);
  }

  const jsonMode = parseJsonFlag(process.argv);
  const formatFlag = parseFormatFlag(process.argv);
  const filterStatus = parseRoadmapFilterFlag(process.argv);
  const search = parseRoadmapSearchFlag(process.argv);
  const verbose = parseVerboseFlag(process.argv);
  const sinceCycle = parseSinceArg(process.argv);

  if (jsonMode) {
    const result = generateRoadmapJson(content, filterStatus, undefined, search, sinceCycle);
    console.log(JSON.stringify(result, null, 2));
  } else if (formatFlag === "md") {
    console.log(generateRoadmapMarkdown(content, filterStatus, search, sinceCycle));
  } else if (formatFlag === "csv") {
    process.stdout.write(generateRoadmapCsv(content, filterStatus, search, sinceCycle));
  } else {
    const output = generateRoadmapOutput(content, filterStatus, search, verbose, sinceCycle);
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
