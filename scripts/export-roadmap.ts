import { writeFileSync, mkdirSync } from "fs";
import { readRoadmap, parseRoadmap, STATUS_DONE } from "../src/planning.js";

// Keep every active item (Backlog / Up Next / In Progress) but cap the
// ever-growing Done archive so roadmap.json stays bounded. parseRoadmap yields
// Done items newest-first, so the first N are the most recently completed.
// Set BLOOM_ROADMAP_DONE_LIMIT=0 to export every Done item.
const parsed = Number(process.env.BLOOM_ROADMAP_DONE_LIMIT);
const doneLimit = Number.isFinite(parsed) ? parsed : 50;

const content = readRoadmap();
let items = parseRoadmap(content);
if (doneLimit > 0) {
  let doneSeen = 0;
  items = items.filter((item) => {
    if (item.status !== STATUS_DONE) return true;
    doneSeen += 1;
    return doneSeen <= doneLimit;
  });
}
mkdirSync("_site", { recursive: true });
writeFileSync("_site/roadmap.json", JSON.stringify(items));
console.log(
  `Exported ${items.length} roadmap items to _site/roadmap.json${doneLimit > 0 ? ` (Done capped at ${doneLimit})` : ""}`,
);
