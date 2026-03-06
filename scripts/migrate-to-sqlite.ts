/**
 * One-time migration: import existing JOURNAL.md and METRICS.json into bloom.db
 */
import { readFileSync, existsSync } from "fs";
import { initDb, insertCycle, insertJournalEntry } from "../src/db.js";
import type { CycleOutcome } from "../src/outcomes.js";

const db = initDb();

// Import METRICS.json if it exists
if (existsSync("METRICS.json")) {
  const metrics = JSON.parse(readFileSync("METRICS.json", "utf-8")) as CycleOutcome[];
  for (const m of metrics) {
    insertCycle(db, m);
  }
  console.log(`Imported ${metrics.length} cycle outcomes from METRICS.json`);
}

// Parse and import JOURNAL.md
if (existsSync("JOURNAL.md")) {
  const journal = readFileSync("JOURNAL.md", "utf-8");
  const cycleRegex = /## Cycle (\d+) — (\S+)/g;
  const sectionRegex = /### (What was attempted|What succeeded|What failed|Learnings)\n([\s\S]*?)(?=### |## Cycle |\n---\n|$)/g;

  const sectionMap: Record<string, string> = {
    "What was attempted": "attempted",
    "What succeeded": "succeeded",
    "What failed": "failed",
    "Learnings": "learnings",
  };

  // Find all cycle positions
  const cycles: { cycleNumber: number; date: string; start: number }[] = [];
  let match;
  while ((match = cycleRegex.exec(journal)) !== null) {
    cycles.push({
      cycleNumber: parseInt(match[1], 10),
      date: match[2],
      start: match.index,
    });
  }

  // Ensure cycle rows exist for journal entries
  const existingCycles = new Set(
    (db.prepare("SELECT cycle_number FROM cycles").all() as { cycle_number: number }[])
      .map(r => r.cycle_number)
  );

  let imported = 0;
  for (let i = 0; i < cycles.length; i++) {
    const cycle = cycles[i];
    const end = i + 1 < cycles.length ? cycles[i + 1].start : journal.length;
    const block = journal.slice(cycle.start, end);

    // Create cycle row if it doesn't exist (from METRICS.json import)
    if (!existingCycles.has(cycle.cycleNumber)) {
      insertCycle(db, {
        cycleNumber: cycle.cycleNumber,
        preflightPassed: true,
        improvementsAttempted: 0,
        improvementsSucceeded: 0,
        buildVerificationPassed: true,
        pushSucceeded: true,
        testCountBefore: null,
        testCountAfter: null,
      });
      existingCycles.add(cycle.cycleNumber);
    }

    // Extract sections
    let sectionMatch;
    const localRegex = /### (What was attempted|What succeeded|What failed|Learnings)\n([\s\S]*?)(?=### |## Cycle |\n---\n|$)/g;
    while ((sectionMatch = localRegex.exec(block)) !== null) {
      const sectionName = sectionMap[sectionMatch[1]];
      const content = sectionMatch[2].trim();
      if (sectionName && content) {
        insertJournalEntry(db, cycle.cycleNumber, sectionName, content);
        imported++;
      }
    }
  }

  console.log(`Imported ${imported} journal sections from ${cycles.length} cycles in JOURNAL.md`);
}

db.close();
console.log("Migration complete. bloom.db created.");
