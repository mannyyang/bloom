/**
 * Shared CSV utility for RFC 4180-compliant field quoting.
 * Used by journal.ts and roadmap.ts to avoid duplicating quoting logic.
 */

/**
 * Wrap a single CSV field value per RFC 4180:
 * - Fields containing commas, double-quotes, CR, or LF are wrapped in double-quotes.
 * - Any double-quote within the field is escaped by doubling it ("").
 * - null / undefined are treated as an empty string.
 */
export function csvQuoteField(value: string | null | undefined): string {
  const s = value ?? "";
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
