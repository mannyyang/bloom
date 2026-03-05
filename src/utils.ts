import { readFileSync, writeFileSync } from "fs";

const DEFAULT_PATH = "DAY_COUNT";

export function getDayCount(filePath: string = DEFAULT_PATH): number {
  try {
    return parseInt(readFileSync(filePath, "utf-8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

export function incrementDayCount(filePath: string = DEFAULT_PATH): number {
  const count = getDayCount(filePath) + 1;
  writeFileSync(filePath, String(count));
  return count;
}
