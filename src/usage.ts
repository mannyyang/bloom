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
    typeof val === "number" ? val : 0;

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
  return {
    phases,
    totalCostUsd: phases.reduce((sum, p) => sum + p.totalCostUsd, 0),
    totalInputTokens: phases.reduce((sum, p) => sum + p.inputTokens, 0),
    totalOutputTokens: phases.reduce((sum, p) => sum + p.outputTokens, 0),
    totalCacheReadTokens: phases.reduce((sum, p) => sum + p.cacheReadInputTokens, 0),
    totalCacheCreationTokens: phases.reduce((sum, p) => sum + p.cacheCreationInputTokens, 0),
  };
}

/**
 * Format a PhaseUsage into a human-readable log line.
 */
export function formatPhaseUsage(pu: PhaseUsage): string {
  const cost = pu.totalCostUsd.toFixed(4);
  const input = pu.inputTokens.toLocaleString();
  const output = pu.outputTokens.toLocaleString();
  const duration = (pu.durationMs / 1000).toFixed(1);
  return `[${pu.phase}] Cost: $${cost} | Tokens: ${input} in / ${output} out | Turns: ${pu.numTurns} | Duration: ${duration}s`;
}

/**
 * Format a CycleUsage into a human-readable summary.
 */
export function formatCycleUsage(cu: CycleUsage): string {
  const lines = cu.phases.map(formatPhaseUsage);
  const totalCost = cu.totalCostUsd.toFixed(4);
  const totalIn = cu.totalInputTokens.toLocaleString();
  const totalOut = cu.totalOutputTokens.toLocaleString();
  const cachePart = (cu.totalCacheReadTokens > 0 || cu.totalCacheCreationTokens > 0)
    ? ` | Cache: ${cu.totalCacheReadTokens.toLocaleString()} read / ${cu.totalCacheCreationTokens.toLocaleString()} created`
    : "";
  lines.push(`[Total] Cost: $${totalCost} | Tokens: ${totalIn} in / ${totalOut} out${cachePart}`);
  return lines.join("\n");
}

/**
 * Format usage data for inclusion in a journal entry.
 */
export function formatUsageForJournal(cu: CycleUsage): string {
  const lines: string[] = ["### Resource Usage", ""];
  for (const p of cu.phases) {
    const cost = p.totalCostUsd.toFixed(4);
    lines.push(
      `- **${p.phase}**: $${cost} — ${p.inputTokens.toLocaleString()} input tokens, ${p.outputTokens.toLocaleString()} output tokens, ${p.numTurns} turns`,
    );
  }
  const cacheSuffix = (cu.totalCacheReadTokens > 0 || cu.totalCacheCreationTokens > 0)
    ? ` (cache: ${cu.totalCacheReadTokens.toLocaleString()} read, ${cu.totalCacheCreationTokens.toLocaleString()} created)`
    : "";
  lines.push(
    `- **Total**: $${cu.totalCostUsd.toFixed(4)} — ${cu.totalInputTokens.toLocaleString()} input + ${cu.totalOutputTokens.toLocaleString()} output tokens${cacheSuffix}`,
  );
  return lines.join("\n");
}
