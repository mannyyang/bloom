/**
 * Token and cost usage tracking for Bloom evolution cycles.
 * Extracts usage data from SDK result messages and provides summaries.
 */

export interface PhaseUsage {
  phase: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  durationMs: number;
  numTurns: number;
}

export interface CycleUsage {
  phases: PhaseUsage[];
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalTurns: number;
}

/**
 * Number of decimal places used when formatting USD cost values.
 * Four decimal places gives sub-cent precision for per-cycle cost reporting.
 */
export const COST_DECIMAL_PLACES = 4;

/**
 * Markdown section header written at the top of every formatted resource-usage block.
 * Exported so tests can pin its exact value and callers can reference it without
 * relying on a hard-coded string literal.
 */
export const RESOURCE_USAGE_HEADER = "### Resource Usage";

/**
 * Format a millisecond duration as a human-readable string.
 * Durations under 60 s are shown as "1.2s"; durations of 60 s or more are
 * shown as "3m 3.0s" so that multi-minute cycles are immediately readable.
 * e.g. 1234 → "1.2s", 183000 → "3m 3.0s"
 */
export function formatDurationSec(ms: number): string {
  if (ms <= 0) return "0.0s";
  const totalSec = ms / 1000;
  // Use the rounded display value for the branch condition so that values whose
  // toFixed(1) output would be "60.0" are routed to the minute branch instead of
  // appearing as the anomalous sub-minute string "60.0s".
  if (Math.round(totalSec * 10) < 600) {
    return `${totalSec.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSec / 60);
  const remainingSec = totalSec - minutes * 60;
  return `${minutes}m ${remainingSec.toFixed(1)}s`;
}

/**
 * Safely extract the `result` text from an opaque SDK message.
 * Returns `null` if the message doesn't contain a string `result` field.
 * This replaces scattered unsafe `as { result: string }` casts.
 */
export function extractResultText(msg: unknown): string | null {
  if (typeof msg !== "object" || msg === null) return null;
  const rec = msg as Record<string, unknown>;
  if ("result" in rec && typeof rec.result === "string") return rec.result;
  return null;
}

/**
 * Extract usage data from an SDK result message.
 * Returns null if the message is not a result message or lacks usage data.
 * Accepts `unknown` so callers don't need `as` casts on opaque SDK messages.
 */
export function extractUsage(
  msg: unknown,
  phase: string,
): PhaseUsage | null {
  if (typeof msg !== "object" || msg === null) return null;

  const rec = msg as Record<string, unknown>;
  if (rec.type !== "result") return null;
  if (typeof rec.total_cost_usd !== "number") return null;

  const usage =
    rec.usage != null && typeof rec.usage === "object"
      ? (rec.usage as Record<string, unknown>)
      : undefined;

  const numOrZero = (val: unknown): number =>
    typeof val === "number" && val >= 0 ? val : 0;

  return {
    phase,
    totalCostUsd: rec.total_cost_usd,
    inputTokens: numOrZero(usage?.input_tokens),
    outputTokens: numOrZero(usage?.output_tokens),
    cacheReadInputTokens: numOrZero(usage?.cache_read_input_tokens),
    cacheCreationInputTokens: numOrZero(usage?.cache_creation_input_tokens),
    durationMs: numOrZero(rec.duration_ms),
    numTurns: numOrZero(rec.num_turns),
  };
}

/**
 * Aggregate multiple phase usages into a cycle-level summary.
 */
export function aggregateUsage(phases: PhaseUsage[]): CycleUsage {
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalTurns = 0;
  for (const p of phases) {
    totalCostUsd += p.totalCostUsd;
    totalInputTokens += p.inputTokens;
    totalOutputTokens += p.outputTokens;
    totalCacheReadTokens += p.cacheReadInputTokens;
    totalCacheCreationTokens += p.cacheCreationInputTokens;
    totalTurns += p.numTurns;
  }
  return { phases, totalCostUsd, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheCreationTokens, totalTurns };
}

/**
 * Format cache token counts as a console display suffix.
 * Returns an empty string when both counts are zero (cache not used).
 * Shared by formatPhaseUsage and formatCycleUsage to eliminate duplication.
 */
function formatCacheDisplaySuffix(readTokens: number, creationTokens: number): string {
  if (readTokens === 0 && creationTokens === 0) return "";
  return ` | Cache: ${readTokens.toLocaleString()} read / ${creationTokens.toLocaleString()} created`;
}

/**
 * Format a PhaseUsage into a human-readable log line.
 * Includes a cache suffix inline when either cache token count is non-zero,
 * keeping the output single-line while surfacing per-phase cache efficiency.
 */
export function formatPhaseUsage(pu: PhaseUsage): string {
  const cost = pu.totalCostUsd.toFixed(COST_DECIMAL_PLACES);
  const input = pu.inputTokens.toLocaleString();
  const output = pu.outputTokens.toLocaleString();
  const duration = formatDurationSec(pu.durationMs);
  const cachePart = formatCacheDisplaySuffix(pu.cacheReadInputTokens, pu.cacheCreationInputTokens);
  return `[${pu.phase}] Cost: $${cost} | Tokens: ${input} in / ${output} out${cachePart} | Turns: ${pu.numTurns} | Duration: ${duration}`;
}

/**
 * Format a CycleUsage into a human-readable summary.
 */
export function formatCycleUsage(cu: CycleUsage): string {
  const lines = cu.phases.map(formatPhaseUsage);
  const totalCost = cu.totalCostUsd.toFixed(COST_DECIMAL_PLACES);
  const totalIn = cu.totalInputTokens.toLocaleString();
  const totalOut = cu.totalOutputTokens.toLocaleString();
  const cachePart = formatCacheDisplaySuffix(cu.totalCacheReadTokens, cu.totalCacheCreationTokens);
  lines.push(`[Total] Cost: $${totalCost} | Tokens: ${totalIn} in / ${totalOut} out${cachePart} | Turns: ${cu.totalTurns}`);
  return lines.join("\n");
}

/**
 * Format cache token counts as a journal-entry suffix.
 * Returns an empty string when both counts are zero (cache not used).
 * Shared by formatUsageForJournal to eliminate duplicated inline ternaries.
 */
function formatJournalCacheSuffix(readTokens: number, creationTokens: number): string {
  if (readTokens === 0 && creationTokens === 0) return "";
  return ` (cache: ${readTokens.toLocaleString()} read, ${creationTokens.toLocaleString()} created)`;
}

/**
 * Format a single journal usage line with a label, cost, and a pre-built body string.
 * Centralises the `- **label**: $cost — body` pattern shared by the per-phase and
 * total lines in formatUsageForJournal, reducing the diff surface for future format changes.
 */
function formatJournalLine(label: string, costUsd: number, body: string): string {
  return `- **${label}**: $${costUsd.toFixed(COST_DECIMAL_PLACES)} — ${body}`;
}

/**
 * Format usage data for inclusion in a journal entry.
 */
export function formatUsageForJournal(cu: CycleUsage): string {
  const lines: string[] = [RESOURCE_USAGE_HEADER, ""];
  for (const p of cu.phases) {
    const duration = formatDurationSec(p.durationMs);
    const phaseCacheSuffix = formatJournalCacheSuffix(p.cacheReadInputTokens, p.cacheCreationInputTokens);
    lines.push(
      formatJournalLine(
        p.phase,
        p.totalCostUsd,
        `${p.inputTokens.toLocaleString()} input tokens, ${p.outputTokens.toLocaleString()} output tokens${phaseCacheSuffix}, ${p.numTurns} turns, ${duration}`,
      ),
    );
  }
  const cacheSuffix = formatJournalCacheSuffix(cu.totalCacheReadTokens, cu.totalCacheCreationTokens);
  lines.push(
    formatJournalLine(
      "Total",
      cu.totalCostUsd,
      `${cu.totalInputTokens.toLocaleString()} input + ${cu.totalOutputTokens.toLocaleString()} output tokens${cacheSuffix}, ${cu.totalTurns} turns`,
    ),
  );
  return lines.join("\n");
}
