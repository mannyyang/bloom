import { writeFileSync, mkdirSync } from "fs";

/**
 * Parse a numeric limit from an environment variable, falling back to `fallback`
 * when the variable is unset or non-numeric. A value of 0 is preserved — callers
 * treat it as the "export everything" sentinel.
 */
export function parseEnvLimit(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Serialize `data` as compact JSON into `_site/<filename>` (creating `_site` if
 * needed) and log a one-line summary. Shared by the GitHub Pages export scripts
 * so the output directory, JSON encoding, and summary logging live in one place.
 */
export function writeSiteJson(filename: string, data: unknown, summary: string): void {
  mkdirSync("_site", { recursive: true });
  writeFileSync(`_site/${filename}`, JSON.stringify(data));
  console.log(summary);
}
