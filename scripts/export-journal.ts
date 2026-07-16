import { writeFileSync, mkdirSync } from "fs";
import { initDb, exportJournalJson } from "../src/db.js";

// Cap how many recent cycles the public site exports so journal.json stays
// bounded as the project keeps evolving — the file is fetched in full by every
// visitor. The complete history remains in bloom.db and via `pnpm journal`.
// Set BLOOM_JOURNAL_LIMIT=0 to export every cycle.
const parsed = Number(process.env.BLOOM_JOURNAL_LIMIT);
const maxCycles = Number.isFinite(parsed) ? parsed : 200;

const db = initDb();
const entries = exportJournalJson(db, maxCycles > 0 ? maxCycles : undefined);
mkdirSync("_site", { recursive: true });
writeFileSync("_site/journal.json", JSON.stringify(entries));
console.log(
  `Exported ${entries.length} journal entries to _site/journal.json${maxCycles > 0 ? ` (most recent ${maxCycles} cycles)` : ""}`,
);
db.close();
