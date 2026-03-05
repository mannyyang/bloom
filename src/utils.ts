import { readFileSync, writeFileSync } from "fs";

export function getDayCount(): number {
  try {
    return parseInt(readFileSync("DAY_COUNT", "utf-8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

export function incrementDayCount(): number {
  const count = getDayCount() + 1;
  writeFileSync("DAY_COUNT", String(count));
  return count;
}
