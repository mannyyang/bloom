/**
 * CLI entry point for inspecting Bloom's accumulated memory.
 * Prints strategic context and all learnings from the SQLite database.
 *
 * Default mode: outputs the budget-capped memory block that would be injected
 * into the assessment prompt (same content as the assessment sees).
 * Verbose mode: prints every learning by category with relevance scores,
 * uncapped by the MAX_MEMORY_CHARS budget.
 *
 * Usage: pnpm memory [options]
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { initDb, getRelevantLearnings, getLatestStrategicContext } from "../src/db.js";
import {
  formatMemoryForPrompt,
  LEARNING_CATEGORIES,
  MAX_MEMORY_CHARS,
} from "../src/memory.js";
import { parseHelpFlag, parseVerboseFlag } from "../src/stats.js";

/** Usage text printed when `pnpm memory --help` is invoked. */
export const MEMORY_HELP_TEXT = `\
Usage: pnpm memory [options]

Options:
  --verbose     Show all learnings by category with relevance scores (uncapped)
  --help, -h    Print this help message and exit
`;

/**
 * Core memory output logic, accepting a db parameter for testability.
 * Returns an array of lines to be printed to stdout.
 *
 * Default mode: returns the same budget-capped memory block injected into the
 * assessment prompt so operators can see exactly what the agent knows.
 * Verbose mode: returns every stored learning grouped by category, each line
 * prefixed with its current relevance score — useful for debugging decay.
 */
export function generateMemoryOutput(
  db: Database.Database,
  verbose?: boolean,
): string[] {
  const lines: string[] = [];

  if (verbose) {
    // Show strategic context first
    const strategic = getLatestStrategicContext(db);
    if (strategic) {
      lines.push("## Strategic Context");
      lines.push(strategic);
      lines.push("");
    }

    // Show all learnings by category with relevance scores (uncapped)
    lines.push("## Learnings by Category");
    let totalLearnings = 0;
    for (const category of LEARNING_CATEGORIES) {
      const items = getRelevantLearnings(db, 100, category);
      if (items.length === 0) continue;
      lines.push(`### ${category} (${items.length})`);
      for (const item of items) {
        lines.push(`  [${item.relevance.toFixed(3)}] ${item.content}`);
      }
      lines.push("");
      totalLearnings += items.length;
    }
    if (totalLearnings === 0) {
      lines.push("No learnings stored yet.");
    }
  } else {
    // Budget-capped memory snapshot — identical to what the assessment prompt receives
    const memory = formatMemoryForPrompt(db, MAX_MEMORY_CHARS);
    if (memory) {
      lines.push(memory);
    } else {
      lines.push("No memory stored yet.");
    }
  }

  return lines;
}

function main() {
  if (parseHelpFlag(process.argv)) {
    process.stdout.write(MEMORY_HELP_TEXT);
    return;
  }
  const verbose = parseVerboseFlag(process.argv);
  const db = initDb();

  try {
    const output = generateMemoryOutput(db, verbose);
    for (const line of output) {
      console.log(line);
    }
  } finally {
    db.close();
  }
}

// Only run when executed directly as a CLI script, not when imported
const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  main();
}
