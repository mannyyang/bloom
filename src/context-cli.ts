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
import { parseVerboseFlag, parseHelpFlag, parseCycleArg } from "./stats.js";

/**
 * Usage text printed when `pnpm context --help` is invoked.
 */
export const CONTEXT_CLI_HELP_TEXT = `\
Usage: pnpm context [options]

Options:
  --verbose             Print the full content of each context section
  --cycle N             Load context as it would appear for cycle N (default: latest + 1)
  --help, -h            Print this help message and exit
`;

export async function main() {
  // --help: print usage text and exit immediately (no DB, no LLM call).
  if (parseHelpFlag(process.argv)) {
    process.stdout.write(CONTEXT_CLI_HELP_TEXT);
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
