import { writeFileSync, mkdirSync } from "fs";
import { initDb, exportJournalJson } from "../src/db.js";

const db = initDb();
const entries = exportJournalJson(db);
mkdirSync("_site", { recursive: true });
writeFileSync("_site/journal.json", JSON.stringify(entries, null, 2));
console.log(`Exported ${entries.length} journal entries to _site/journal.json`);
db.close();
