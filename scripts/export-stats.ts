import { initDb, getCycleRows } from "../src/db.js";
import { parseEnvLimit, writeSiteJson } from "./export-util.js";

// Export a bounded, newest-first slice of per-cycle metrics for the Stats tab
// on the GitHub Pages site. Kept small (fetched in full by every visitor);
// the complete history remains in bloom.db and via `pnpm stats`.
// Set BLOOM_STATS_LIMIT=0 to export every cycle.
const limit = parseEnvLimit("BLOOM_STATS_LIMIT", 100);

const db = initDb();
const cycles = getCycleRows(db, limit > 0 ? limit : Number.MAX_SAFE_INTEGER);
writeSiteJson(
  "stats.json",
  { cycles },
  `Exported ${cycles.length} cycle rows to _site/stats.json${limit > 0 ? ` (most recent ${limit})` : ""}`,
);
db.close();
