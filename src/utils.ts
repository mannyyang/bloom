import { readFileSync, writeFileSync } from "fs";

const DEFAULT_PATH = "CYCLE_COUNT";

export function getCycleCount(filePath: string = DEFAULT_PATH): number {
  try {
    return parseInt(readFileSync(filePath, "utf-8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

export function incrementCycleCount(filePath: string = DEFAULT_PATH): number {
  const count = getCycleCount(filePath) + 1;
  writeFileSync(filePath, String(count));
  return count;
}
