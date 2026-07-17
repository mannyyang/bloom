import { readRoadmap, parseRoadmap, STATUS_DONE } from "../src/planning.js";
import { parseEnvLimit, writeSiteJson } from "./export-util.js";

// Keep every active item (Backlog / Up Next / In Progress) but cap the
// ever-growing Done archive so roadmap.json stays bounded. parseRoadmap yields
// Done items newest-first, so the first N are the most recently completed.
// Set BLOOM_ROADMAP_DONE_LIMIT=0 to export every Done item.
const doneLimit = parseEnvLimit("BLOOM_ROADMAP_DONE_LIMIT", 50);

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
writeSiteJson(
  "roadmap.json",
  items,
  `Exported ${items.length} roadmap items to _site/roadmap.json${doneLimit > 0 ? ` (Done capped at ${doneLimit})` : ""}`,
);
