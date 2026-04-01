import { writeFileSync, mkdirSync } from "fs";
import { readRoadmap, parseRoadmap } from "../src/planning.js";

const content = readRoadmap();
const items = parseRoadmap(content);
mkdirSync("_site", { recursive: true });
writeFileSync("_site/roadmap.json", JSON.stringify(items, null, 2));
console.log(`Exported ${items.length} roadmap items to _site/roadmap.json`);
