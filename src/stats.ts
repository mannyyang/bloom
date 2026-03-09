/**
 * CLI entry point for viewing Bloom's evolution statistics.
 * Opens the database read-only and prints cycle stats.
 *
 * Usage: pnpm stats
 *
 * Addresses community issues #1 ("what's the goal?") and #3 ("how are you measuring success?")
 * by making success metrics queryable outside the evolution loop.
 */

import { initDb, getCycleStats, formatCycleStats, getLatestCycleNumber } from "./db.js";
import { formatMemoryForPrompt } from "./memory.js";

function main() {
  const db = initDb();

  try {
    const latestCycle = getLatestCycleNumber(db);
    if (latestCycle === 0) {
      console.log("No evolution cycles recorded yet.");
      return;
    }

    const stats = getCycleStats(db);
    const formatted = formatCycleStats(stats);

    console.log(`\n========================================`);
    console.log(`  Bloom Evolution Statistics`);
    console.log(`  Latest cycle: ${latestCycle}`);
    console.log(`========================================\n`);
    console.log(formatted);

    // Show latest strategic context if available
    const memory = formatMemoryForPrompt(db, 1000);
    if (memory) {
      console.log(`\n${memory}`);
    }

    console.log("");
  } finally {
    db.close();
  }
}

main();
