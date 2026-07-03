import { describe, it, expect } from "vitest";
import { csvQuoteField, filterBySearchTerm } from "../src/csv.js";

describe("csvQuoteField", () => {
  it("returns plain string unchanged when no special chars", () => {
    expect(csvQuoteField("hello")).toBe("hello");
  });

  it("wraps field in double-quotes when it contains a comma", () => {
    expect(csvQuoteField("a,b")).toBe('"a,b"');
  });

  it("wraps field and escapes embedded double-quotes", () => {
    expect(csvQuoteField('say "hello"')).toBe('"say ""hello"""');
  });

  it("wraps field containing a newline", () => {
    expect(csvQuoteField("line1\nline2")).toBe('"line1\nline2"');
  });

  it("wraps field containing a carriage return", () => {
    expect(csvQuoteField("a\rb")).toBe('"a\rb"');
  });

  it("returns empty string for null", () => {
    expect(csvQuoteField(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(csvQuoteField(undefined)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(csvQuoteField("")).toBe("");
  });

  it("escapes multiple double-quotes", () => {
    expect(csvQuoteField('a"b"c')).toBe('"a""b""c"');
  });

  it("handles field with only a comma", () => {
    expect(csvQuoteField(",")).toBe('","');
  });
});

describe("filterBySearchTerm", () => {
  const items = [
    { title: "Add CSV export", body: "Export as comma-separated values" },
    { title: "Fix build failure", body: "TypeScript compiler errors" },
    { title: "Improve test coverage", body: "Add more unit tests" },
  ];

  const getFields = (i: typeof items[number]) => [i.title, i.body];

  it("returns all items when term is empty string", () => {
    expect(filterBySearchTerm(items, "", getFields)).toEqual(items);
  });

  it("returns all items when term is whitespace only", () => {
    expect(filterBySearchTerm(items, "   ", getFields)).toEqual(items);
  });

  it("filters by substring match in title (case-insensitive)", () => {
    const result = filterBySearchTerm(items, "CSV", getFields);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Add CSV export");
  });

  it("filters by substring match in body (case-insensitive)", () => {
    const result = filterBySearchTerm(items, "TypeScript", getFields);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Fix build failure");
  });

  it("matches are case-insensitive", () => {
    const result = filterBySearchTerm(items, "typescript", getFields);
    expect(result).toHaveLength(1);
  });

  it("returns empty array when nothing matches", () => {
    expect(filterBySearchTerm(items, "nonexistent-xyz", getFields)).toEqual([]);
  });

  it("returns multiple matching items", () => {
    const result = filterBySearchTerm(items, "test", getFields);
    // "Improve test coverage" title matches; no other field contains "test"
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Improve test coverage");
  });

  it("skips null/undefined field values without throwing", () => {
    const mixedItems = [
      { title: "alpha", body: null as string | null },
      { title: "beta", body: "match here" },
    ];
    const result = filterBySearchTerm(
      mixedItems,
      "match",
      (i) => [i.title, i.body],
    );
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("beta");
  });

  it("handles an empty items array", () => {
    expect(filterBySearchTerm([], "csv", getFields)).toEqual([]);
  });

  it("trims whitespace from the search term before matching", () => {
    const result = filterBySearchTerm(items, "  csv  ", getFields);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Add CSV export");
  });
});
