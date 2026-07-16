/**
 * Standalone context CLI — loads the full evolution context and prints
 * each section to stdout. Does not make any LLM calls.
 *
 * Useful for cost-free prompt inspection and pipeline debugging without
 * triggering a full evolution cycle.
 *
 * Usage: pnpm context [--verbose] [--cycle N]
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { initDb, getLatestCycleNumber } from "./db.js";
import { loadEvolutionContext } from "./context.js";
import { errorMessage } from "./errors.js";
import { parseVerboseFlag, parseHelpFlag, parseCycleArg, parseDryRunFlag, parseCompareArg } from "./stats.js";

/**
 * Usage text printed when `pnpm context --help` is invoked.
 */
export const CONTEXT_CLI_HELP_TEXT = `\
Usage: pnpm context [options]

Options:
  --verbose             Print the full content of each context section
  --cycle N             Load context as it would appear for cycle N (default: latest + 1)
  --dry-run             Print per-section char-count breakdown with % of total and exit (no DB, no LLM)
  --compare A B         Compare per-section char counts between cycle A and cycle B
  --help, -h            Print this help message and exit
`;

/**
 * Render a dry-run breakdown table: section name, char count, and percentage of
 * total chars. Exported for unit-testability independent of main().
 *
 * @param sections - ordered array of [label, charCount] pairs
 * @returns multi-line string with one row per section plus a Total row
 */
export function renderDryRunBreakdown(sections: Array<[string, number]>): string {
  const total = sections.reduce((sum, [, n]) => sum + n, 0);
  const lines: string[] = [];
  for (const [label, n] of sections) {
    const pct = total > 0 ? ((n / total) * 100).toFixed(1) : "0.0";
    lines.push(`  ${label.padEnd(20)} ${String(n).padStart(6)} chars  ${pct.padStart(5)}%`);
  }
  lines.push(`  ${"Total".padEnd(20)} ${String(total).padStart(6)} chars  100.0%`);
  return lines.join("\n");
}

/**
 * Render a compare breakdown table showing per-section char-count delta between
 * two cycle contexts. Columns: Section / CycleA / CycleB / Δchars / Δ%
 * Exported for unit-testability independent of main().
 *
 * @param sectionsA - ordered array of [label, charCount] pairs for the first cycle
 * @param sectionsB - ordered array of [label, charCount] pairs for the second cycle
 * @param cycleA    - cycle number for the first context (used in column headers)
 * @param cycleB    - cycle number for the second context (used in column headers)
 * @returns multi-line string with one row per section plus a Total row
 */
export function renderCompareBreakdown(
  sectionsA: Array<[string, number]>,
  sectionsB: Array<[string, number]>,
  cycleA: number,
  cycleB: number,
): string {
  const colA = `Cycle ${cycleA}`;
  const colB = `Cycle ${cycleB}`;
  const lines: string[] = [
    `  ${"Section".padEnd(20)} ${colA.padStart(8)} ${colB.padStart(8)} ${"Δchars".padStart(8)} ${"Δ%".padStart(7)}`,
  ];
  for (let i = 0; i < sectionsA.length; i++) {
    const [label, nA] = sectionsA[i];
    const [, nB] = sectionsB[i];
    const delta = nB - nA;
    const sign = delta >= 0 ? "+" : "";
    const pctStr =
      nA > 0
        ? (sign + (((nB - nA) / nA) * 100).toFixed(1) + "%")
        : nB > 0
          ? "+∞%"
          : "0.0%";
    lines.push(
      `  ${label.padEnd(20)} ${String(nA).padStart(8)} ${String(nB).padStart(8)} ${(sign + delta).padStart(8)} ${pctStr.padStart(7)}`,
    );
  }
  const totalA = sectionsA.reduce((sum, [, n]) => sum + n, 0);
  const totalB = sectionsB.reduce((sum, [, n]) => sum + n, 0);
  const totalDelta = totalB - totalA;
  const totalSign = totalDelta >= 0 ? "+" : "";
  const totalPct =
    totalA > 0
      ? (totalSign + (((totalB - totalA) / totalA) * 100).toFixed(1) + "%")
      : totalB > 0
        ? "+∞%"
        : "0.0%";
  lines.push(
    `  ${"Total".padEnd(20)} ${String(totalA).padStart(8)} ${String(totalB).padStart(8)} ${(totalSign + totalDelta).padStart(8)} ${totalPct.padStart(7)}`,
  );
  return lines.join("\n");
}

export async function main() {
  // --help: print usage text and exit immediately (no DB, no LLM call).
  if (parseHelpFlag(process.argv)) {
    process.stdout.write(CONTEXT_CLI_HELP_TEXT);
    return;
  }

  // --compare A B: load contexts for two cycles and print a delta breakdown table.
  const compareArg = parseCompareArg(process.argv);
  if (compareArg !== undefined) {
    const [cycleA, cycleB] = compareArg;
    const db = initDb();
    let ctxA, ctxB;
    try {
      ctxA = await loadEvolutionContext(db, cycleA);
      ctxB = await loadEvolutionContext(db, cycleB);
    } catch (err) {
      console.error(`[context-cli] Failed to load evolution context: ${errorMessage(err)}`);
      db.close();
      process.exit(1);
    }
    db.close();

    const makeSections = (ctx: Awaited<ReturnType<typeof loadEvolutionContext>>): Array<[string, number]> => [
      ["Identity", ctx.identity.length],
      ["Journal summary", ctx.journalSummary?.length ?? 0],
      ["Cycle stats", ctx.cycleStatsText?.length ?? 0],
      ["Memory context", ctx.memoryContext?.length ?? 0],
      ["Planning context", ctx.planningContext?.length ?? 0],
    ];
    console.log(`\nContext comparison (cycle ${cycleA} vs cycle ${cycleB}):\n`);
    console.log(renderCompareBreakdown(makeSections(ctxA), makeSections(ctxB), cycleA, cycleB));
    console.log("");
    return;
  }

  // --dry-run: load context from DB, print char-count breakdown, exit — no LLM call.
  if (parseDryRunFlag(process.argv)) {
    const db = initDb();
    let cycleCount = 0;
    try {
      cycleCount = getLatestCycleNumber(db) + 1;
    } catch {
      // non-fatal — use cycleCount = 0
    }
    let ctx;
    try {
      ctx = await loadEvolutionContext(db, cycleCount);
    } catch (err) {
      console.error(`[context-cli] Failed to load evolution context: ${errorMessage(err)}`);
      db.close();
      process.exit(1);
    }
    db.close();

    const sections: Array<[string, number]> = [
      ["Identity", ctx.identity.length],
      ["Journal summary", ctx.journalSummary?.length ?? 0],
      ["Cycle stats", ctx.cycleStatsText?.length ?? 0],
      ["Memory context", ctx.memoryContext?.length ?? 0],
      ["Planning context", ctx.planningContext?.length ?? 0],
    ];
    console.log("\nContext char-count breakdown (cycle " + cycleCount + "):\n");
    console.log(renderDryRunBreakdown(sections));
    console.log("");
    return;
  }

  const verbose = parseVerboseFlag(process.argv);
  const cycleArg = parseCycleArg(process.argv);

  console.log("\n========================================");
  console.log("  Bloom Context Inspector");
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log("========================================\n");

  const db = initDb();
  let cycleCount = 0;
  if (cycleArg !== undefined) {
    cycleCount = cycleArg;
  } else {
    try {
      cycleCount = getLatestCycleNumber(db) + 1;
    } catch (err) {
      console.error(`[context-cli] Could not load cycle number (non-fatal): ${errorMessage(err)}`);
    }
  }

  let ctx;
  try {
    ctx = await loadEvolutionContext(db, cycleCount);
  } catch (err) {
    console.error(`[context-cli] Failed to load evolution context: ${errorMessage(err)}`);
    db.close();
    process.exit(1);
  }
  db.close();

  console.log("\n========================================");
  console.log("  Context Summary");
  console.log("========================================\n");

  const totalChars =
    ctx.identity.length +
    (ctx.journalSummary?.length ?? 0) +
    (ctx.cycleStatsText?.length ?? 0) +
    (ctx.memoryContext?.length ?? 0) +
    (ctx.planningContext?.length ?? 0);

  console.log(`Cycle:            ${cycleCount}`);
  console.log(`Identity:         ${ctx.identity.length} chars`);
  console.log(`Journal summary:  ${ctx.journalSummary ? `${ctx.journalSummary.length} chars` : "empty"}`);
  console.log(`Cycle stats:      ${ctx.cycleStatsText ? `${ctx.cycleStatsText.length} chars` : "empty"}`);
  console.log(`Memory context:   ${ctx.memoryContext ? `${ctx.memoryContext.length} chars` : "empty"}`);
  console.log(`Planning context: ${ctx.planningContext ? `${ctx.planningContext.length} chars` : "empty"}`);
  console.log(`Community issues: ${ctx.issues.length}`);
  console.log(`Current focus:    ${ctx.currentItem ? `"${ctx.currentItem.title}"` : "none"}`);
  console.log(`Total context:    ${totalChars} chars`);

  if (verbose) {
    console.log("\n========================================");
    console.log("  Identity");
    console.log("========================================\n");
    console.log(ctx.identity);

    if (ctx.journalSummary) {
      console.log("\n========================================");
      console.log("  Journal Summary");
      console.log("========================================\n");
      console.log(ctx.journalSummary);
    }

    if (ctx.cycleStatsText) {
      console.log("\n========================================");
      console.log("  Cycle Stats");
      console.log("========================================\n");
      console.log(ctx.cycleStatsText);
    }

    if (ctx.memoryContext) {
      console.log("\n========================================");
      console.log("  Memory Context");
      console.log("========================================\n");
      console.log(ctx.memoryContext);
    }

    if (ctx.planningContext) {
      console.log("\n========================================");
      console.log("  Planning Context");
      console.log("========================================\n");
      console.log(ctx.planningContext);
    }
  }
}

// Only auto-run when executed directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error("Context CLI failed:", errorMessage(err));
    process.exit(1);
  });
}
