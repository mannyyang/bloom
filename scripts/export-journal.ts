import { initDb, exportJournalJson } from "../src/db.js";
import { parseEnvLimit, writeSiteJson } from "./export-util.js";

// Cap how many recent cycles the public site exports so journal.json stays
// bounded as the project keeps evolving — the file is fetched in full by every
// visitor. The complete history remains in bloom.db and via `pnpm journal`.
// Set BLOOM_JOURNAL_LIMIT=0 to export every cycle.
const maxCycles = parseEnvLimit("BLOOM_JOURNAL_LIMIT", 200);

const db = initDb();
const entries = exportJournalJson(db, maxCycles > 0 ? maxCycles : undefined);
writeSiteJson(
  "journal.json",
  entries,
  `Exported ${entries.length} journal entries to _site/journal.json${maxCycles > 0 ? ` (most recent ${maxCycles} cycles)` : ""}`,
);
db.close();
