/**
 * Shared CSV utility for RFC 4180-compliant field quoting.
 * Used by journal.ts and roadmap.ts to avoid duplicating quoting logic.
 */

/**
 * Generic case-insensitive search filter for arrays of items.
 *
 * Returns only items where at least one field returned by `getFields` contains
 * `term` as a substring (case-insensitive). `null` and `undefined` field values
 * are skipped and never match. An empty or whitespace-only `term` returns all items.
 *
 * Used by journal.ts and roadmap.ts to avoid duplicating the same
 * "lowercase .includes" pattern in private helpers.
 *
 * @example
 * filterBySearchTerm(items, "csv", (i) => [i.title, i.body])
 */
export function filterBySearchTerm<T>(
  items: T[],
  term: string,
  getFields: (item: T) => (string | null | undefined)[],
): T[] {
  const trimmed = term.trim();
  if (trimmed.length === 0) return items;
  const lower = trimmed.toLowerCase();
  return items.filter((item) =>
    getFields(item).some((field) => field != null && field.toLowerCase().includes(lower)),
  );
}

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
