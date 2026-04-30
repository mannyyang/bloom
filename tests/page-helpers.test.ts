import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  parseRoadmapSections,
  renderSection,
  renderStatsSection,
  renderJournalSection,
  renderJournalCards,
  renderNav,
  generateHtml,
  generateJournalHtml,
  generateStatsHtml,
  STATUS_COLORS,
  STATUS_COLOR_BACKLOG,
  STATUS_COLOR_UP_NEXT,
  STATUS_COLOR_IN_PROGRESS,
  STATUS_COLOR_DONE,
} from "../src/page-helpers.js";
import type { DbStats, JournalEntry, RoadmapSection } from "../src/page-helpers.js";

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe("escapeHtml", () => {
  it("escapes ampersand", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });
  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });
  it("escapes double quotes", () => {
    expect(escapeHtml('say "hi"')).toBe("say &quot;hi&quot;");
  });
  it("leaves plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
  it("does not escape single quotes (only double-quoted attribute context is used)", () => {
    // Single quotes are intentionally left unescaped — all HTML attributes in
    // page-helpers.ts use double quotes, so ' is safe and must not become &#39;.
    expect(escapeHtml("it's fine")).toBe("it's fine");
  });
});

// ---------------------------------------------------------------------------
// parseRoadmapSections
// ---------------------------------------------------------------------------

describe("parseRoadmapSections", () => {
  it("returns empty array for empty content", () => {
    expect(parseRoadmapSections("")).toEqual([]);
  });

  it("parses a simple section with one unchecked item", () => {
    const md = `## Backlog\n- [ ] Do something\n`;
    const sections = parseRoadmapSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("Backlog");
    expect(sections[0].items).toHaveLength(1);
    expect(sections[0].items[0]).toMatchObject({
      done: false,
      title: "Do something",
      issueNumber: null,
      description: "",
    });
  });

  it("parses a checked item", () => {
    const md = `## Done\n- [x] Completed task\n`;
    const sections = parseRoadmapSections(md);
    expect(sections[0].items[0].done).toBe(true);
  });

  it("extracts issue number from title", () => {
    const md = `## Up Next\n- [ ] Add feature (#42)\n`;
    const sections = parseRoadmapSections(md);
    expect(sections[0].items[0].issueNumber).toBe(42);
    expect(sections[0].items[0].title).toBe("Add feature");
  });

  it("null issueNumber when no issue reference", () => {
    const md = `## Backlog\n- [ ] Plain item\n`;
    const sections = parseRoadmapSections(md);
    expect(sections[0].items[0].issueNumber).toBeNull();
  });

  it("accumulates indented description lines", () => {
    const md = `## Backlog\n- [ ] Big task\n  First line.\n  Second line.\n`;
    const sections = parseRoadmapSections(md);
    expect(sections[0].items[0].description).toBe("First line. Second line.");
  });

  it("skips [since: N] lines", () => {
    const md = `## Done\n- [x] Old task\n  [since: 100]\n`;
    const sections = parseRoadmapSections(md);
    expect(sections[0].items[0].description).toBe("");
  });

  it("parses multiple sections", () => {
    const md = `## Backlog\n- [ ] Task A\n## Done\n- [x] Task B\n`;
    const sections = parseRoadmapSections(md);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe("Backlog");
    expect(sections[1].heading).toBe("Done");
  });

  it("ignores items outside any section", () => {
    const md = `- [ ] Orphan item\n## Backlog\n- [ ] Actual item\n`;
    const sections = parseRoadmapSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].items).toHaveLength(1);
    expect(sections[0].items[0].title).toBe("Actual item");
  });

  it("handles section with no items", () => {
    const md = `## Empty\n`;
    const sections = parseRoadmapSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// renderSection
// ---------------------------------------------------------------------------

describe("renderSection", () => {
  it("returns empty string for section with no items", () => {
    const section: RoadmapSection = { heading: "Backlog", items: [] };
    expect(renderSection(section)).toBe("");
  });

  it("includes the heading text", () => {
    const section: RoadmapSection = {
      heading: "In Progress",
      items: [{ done: false, title: "Do stuff", issueNumber: null, description: "" }],
    };
    const html = renderSection(section);
    expect(html).toContain("In Progress");
  });

  it("renders issue link when issueNumber is set", () => {
    const section: RoadmapSection = {
      heading: "Up Next",
      items: [{ done: false, title: "My task", issueNumber: 7, description: "" }],
    };
    const html = renderSection(section);
    expect(html).toContain("#7");
    expect(html).toContain("/issues/7");
  });

  it("does not render issue link when issueNumber is null", () => {
    const section: RoadmapSection = {
      heading: "Backlog",
      items: [{ done: false, title: "No issue", issueNumber: null, description: "" }],
    };
    const html = renderSection(section);
    expect(html).not.toContain("issue-link");
  });

  it("adds done class for completed items", () => {
    const section: RoadmapSection = {
      heading: "Done",
      items: [{ done: true, title: "Finished", issueNumber: null, description: "" }],
    };
    const html = renderSection(section);
    expect(html).toContain('class="item done"');
  });

  it("escapes HTML in item title", () => {
    const section: RoadmapSection = {
      heading: "Backlog",
      items: [{ done: false, title: "<script>xss</script>", issueNumber: null, description: "" }],
    };
    const html = renderSection(section);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("renders description when present", () => {
    const section: RoadmapSection = {
      heading: "Backlog",
      items: [{ done: false, title: "Task", issueNumber: null, description: "A detailed note." }],
    };
    const html = renderSection(section);
    expect(html).toContain("A detailed note.");
    expect(html).toContain("item-desc");
  });
});

// ---------------------------------------------------------------------------
// renderStatsSection
// ---------------------------------------------------------------------------

describe("renderStatsSection", () => {
  const baseStats: DbStats = {
    totalCycles: 50,
    successRate: 80,
    avgImprovements: 1.5,
    avgConversionRate: null,
    recentFailures: 1,
    avgDurationMinutes: null,
    totalCostUsd: 0,
  };

  it("includes total cycles", () => {
    const html = renderStatsSection(baseStats);
    expect(html).toContain("50");
    expect(html).toContain("Total cycles");
  });

  it("includes success rate", () => {
    const html = renderStatsSection(baseStats);
    expect(html).toContain("80%");
  });

  it("omits conversion rate row when null", () => {
    const html = renderStatsSection({ ...baseStats, avgConversionRate: null });
    expect(html).not.toContain("conversion rate");
  });

  it("includes conversion rate row when provided", () => {
    const html = renderStatsSection({ ...baseStats, avgConversionRate: 75 });
    expect(html).toContain("75%");
    expect(html).toContain("conversion rate");
  });

  it("omits duration row when null", () => {
    const html = renderStatsSection({ ...baseStats, avgDurationMinutes: null });
    expect(html).not.toContain("duration");
  });

  it("includes duration row when provided", () => {
    const html = renderStatsSection({ ...baseStats, avgDurationMinutes: 12 });
    expect(html).toContain("12 min");
  });

  it("omits cost row when zero", () => {
    const html = renderStatsSection({ ...baseStats, totalCostUsd: 0 });
    expect(html).not.toContain("Total cost");
  });

  it("includes cost row when positive", () => {
    const html = renderStatsSection({ ...baseStats, totalCostUsd: 3.14 });
    expect(html).toContain("$3.14");
  });

  it("includes recent failures", () => {
    const html = renderStatsSection({ ...baseStats, recentFailures: 2 });
    expect(html).toContain("Recent failures");
  });

  it("total-cycles row contains exact <strong>50</strong> value in <td>", () => {
    const html = renderStatsSection(baseStats);
    const row = html.split("\n").find(l => l.includes("Total cycles"))!;
    expect(row).toBeDefined();
    expect(row).toContain("<strong>50</strong>");
  });

  it("success-rate row contains exact <strong>80%</strong> value in <td>", () => {
    const html = renderStatsSection(baseStats);
    const row = html.split("\n").find(l => l.includes("Success rate"))!;
    expect(row).toBeDefined();
    expect(row).toContain("<strong>80%</strong>");
  });

  it("conversion-rate row contains exact <strong>75%</strong> value when provided", () => {
    const html = renderStatsSection({ ...baseStats, avgConversionRate: 75 });
    const row = html.split("\n").find(l => l.includes("conversion rate"))!;
    expect(row).toBeDefined();
    expect(row).toContain("<strong>75%</strong>");
  });

  it("avg-improvements row contains exact <strong>1.5</strong> value in <td>", () => {
    const html = renderStatsSection(baseStats);
    const row = html.split("\n").find(l => l.includes("Avg improvements / cycle"))!;
    expect(row).toBeDefined();
    expect(row).toContain("<strong>1.5</strong>");
  });

  it("recent-failures row contains exact <strong>1</strong> value in <td>", () => {
    const html = renderStatsSection(baseStats);
    const row = html.split("\n").find(l => l.includes("Recent failures (last 5 cycles)"))!;
    expect(row).toBeDefined();
    expect(row).toContain("<strong>1</strong>");
  });

  it("cost row contains exact <strong>$3.14</strong> value when positive", () => {
    const html = renderStatsSection({ ...baseStats, totalCostUsd: 3.14 });
    const row = html.split("\n").find(l => l.includes("Total cost"))!;
    expect(row).toBeDefined();
    expect(row).toContain("<strong>$3.14</strong>");
  });

  it("duration row contains exact <strong>12 min</strong> value when provided", () => {
    const html = renderStatsSection({ ...baseStats, avgDurationMinutes: 12 });
    const row = html.split("\n").find(l => l.includes("Avg cycle duration"))!;
    expect(row).toBeDefined();
    expect(row).toContain("<strong>12 min</strong>");
  });
});

// ---------------------------------------------------------------------------
// renderJournalCards / renderJournalSection
// ---------------------------------------------------------------------------

const sampleEntry: JournalEntry = {
  cycleNumber: 42,
  date: "2025-01-01",
  attempted: "Fix bug",
  succeeded: "Bug fixed",
  failed: "",
  learnings: "Use types",
};

describe("renderJournalCards", () => {
  it("returns empty string for empty array", () => {
    expect(renderJournalCards([])).toBe("");
  });

  it("includes cycle number", () => {
    const html = renderJournalCards([sampleEntry]);
    expect(html).toContain("Cycle 42");
  });

  it("includes date", () => {
    const html = renderJournalCards([sampleEntry]);
    expect(html).toContain("2025-01-01");
  });

  it("renders attempted field", () => {
    const html = renderJournalCards([sampleEntry]);
    expect(html).toContain("Fix bug");
    expect(html).toContain("Attempted");
  });

  it("renders succeeded field", () => {
    const html = renderJournalCards([sampleEntry]);
    expect(html).toContain("Bug fixed");
    expect(html).toContain("succeeded-label");
  });

  it("omits failed field when empty", () => {
    const html = renderJournalCards([sampleEntry]);
    expect(html).not.toContain("failed-label");
  });

  it("renders failed field when present", () => {
    const entry = { ...sampleEntry, failed: "Broke something" };
    const html = renderJournalCards([entry]);
    expect(html).toContain("Broke something");
    expect(html).toContain("failed-label");
  });

  it("renders learnings field", () => {
    const html = renderJournalCards([sampleEntry]);
    expect(html).toContain("Use types");
  });

  it("escapes HTML in entry fields", () => {
    const entry = { ...sampleEntry, attempted: '<b>bold</b> & "quotes"' };
    const html = renderJournalCards([entry]);
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quotes&quot;");
    expect(html).not.toContain("<b>");
  });

  it("renders as non-collapsible div, not details element", () => {
    const html = renderJournalCards([sampleEntry]);
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<summary");
    expect(html).toContain("journal-card-header");
  });
});

describe("renderJournalSection", () => {
  it("returns empty string for empty array", () => {
    expect(renderJournalSection([])).toBe("");
  });

  it("includes section heading", () => {
    const html = renderJournalSection([sampleEntry]);
    expect(html).toContain("Recent Journal");
  });

  it("includes link to full journal page", () => {
    const html = renderJournalSection([sampleEntry]);
    expect(html).toContain('href="journal.html"');
  });

  it("renders multiple entries", () => {
    const entry2: JournalEntry = { ...sampleEntry, cycleNumber: 43 };
    const html = renderJournalSection([sampleEntry, entry2]);
    expect(html).toContain("Cycle 42");
    expect(html).toContain("Cycle 43");
  });
});

// ---------------------------------------------------------------------------
// renderNav
// ---------------------------------------------------------------------------

describe("renderNav", () => {
  it("renders links to all three pages", () => {
    const html = renderNav("index");
    expect(html).toContain("index.html");
    expect(html).toContain("journal.html");
    expect(html).toContain("stats.html");
  });

  it("bolds the active page link (no text-decoration + font-weight:700)", () => {
    const html = renderNav("journal");
    expect(html).toContain("font-weight:700");
  });

  it("active page link does not point to same href as a plain link", () => {
    // The active page should use font-weight:700 style; the others use color:#2563eb
    const html = renderNav("stats");
    expect(html).toContain("color:#2563eb");   // non-active links
    expect(html).toContain("font-weight:700"); // active link
  });

  it("renderNav('journal') bolds the journal link and leaves index/stats links plain", () => {
    const html = renderNav("journal");
    // Active journal link must contain bold style
    expect(html).toContain('href="journal.html" style="color:#111827;font-weight:700');
    // Non-active links must use the plain link colour, not bold
    expect(html).toContain('href="index.html" style="color:#2563eb');
    expect(html).toContain('href="stats.html" style="color:#2563eb');
  });

  it("renderNav('index') bolds the index link and leaves journal/stats links plain", () => {
    const html = renderNav("index");
    // Active index link must contain bold style
    expect(html).toContain('href="index.html" style="color:#111827;font-weight:700');
    // Non-active links must use the plain link colour, not bold
    expect(html).toContain('href="journal.html" style="color:#2563eb');
    expect(html).toContain('href="stats.html" style="color:#2563eb');
  });

  it("renderNav('stats') bolds the stats link and leaves index/journal links plain", () => {
    const html = renderNav("stats");
    // Active stats link must contain bold style
    expect(html).toContain('href="stats.html" style="color:#111827;font-weight:700');
    // Non-active links must use the plain link colour, not bold
    expect(html).toContain('href="index.html" style="color:#2563eb');
    expect(html).toContain('href="journal.html" style="color:#2563eb');
  });
});

// ---------------------------------------------------------------------------
// generateHtml
// ---------------------------------------------------------------------------

describe("generateHtml", () => {
  const section: RoadmapSection = {
    heading: "Backlog",
    items: [{ done: false, title: "Task A", issueNumber: null, description: "" }],
  };

  it("contains the page title", () => {
    const html = generateHtml([section], "now", "", "");
    expect(html).toContain("<title>Bloom Evolution Roadmap</title>");
  });

  it("contains the generatedAt timestamp", () => {
    const html = generateHtml([section], "2025-01-01T00:00:00Z", "", "");
    expect(html).toContain("2025-01-01T00:00:00Z");
  });

  it("renders roadmap section content", () => {
    const html = generateHtml([section], "now", "", "");
    expect(html).toContain("Task A");
    expect(html).toContain("Backlog");
  });

  it("includes nav bar", () => {
    const html = generateHtml([section], "now", "", "");
    expect(html).toContain("journal.html");
    expect(html).toContain("stats.html");
  });

  it("includes optional statsSection when provided", () => {
    const html = generateHtml([], "now", "<p>my-stats</p>", "");
    expect(html).toContain("my-stats");
  });

  it("includes optional journalSection when provided", () => {
    const html = generateHtml([], "now", "", "<p>my-journal</p>");
    expect(html).toContain("my-journal");
  });

  it("returns a complete HTML document", () => {
    const html = generateHtml([], "now", "", "");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });
});

// ---------------------------------------------------------------------------
// generateJournalHtml
// ---------------------------------------------------------------------------

describe("generateJournalHtml", () => {
  it("contains the journal page title", () => {
    const html = generateJournalHtml([], "now");
    expect(html).toContain("<title>Bloom Full Journal</title>");
  });

  it("shows no-entries message when array is empty", () => {
    const html = generateJournalHtml([], "now");
    expect(html).toContain("No journal entries yet.");
  });

  it("renders entries when provided", () => {
    const html = generateJournalHtml([sampleEntry], "now");
    expect(html).toContain("Cycle 42");
    expect(html).toContain("Fix bug");
  });

  it("includes nav bar with links to other pages", () => {
    const html = generateJournalHtml([], "now");
    expect(html).toContain("index.html");
    expect(html).toContain("stats.html");
  });

  it("contains the generatedAt timestamp", () => {
    const html = generateJournalHtml([], "2025-06-15");
    expect(html).toContain("2025-06-15");
  });

  it("returns a complete HTML document", () => {
    const html = generateJournalHtml([], "now");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });
});

// ---------------------------------------------------------------------------
// generateStatsHtml
// ---------------------------------------------------------------------------

const sampleStats: DbStats = {
  totalCycles: 100,
  successRate: 75,
  avgImprovements: 1.8,
  avgConversionRate: 90,
  recentFailures: 2,
  avgDurationMinutes: 15,
  totalCostUsd: 4.5,
};

describe("generateStatsHtml", () => {
  it("contains the stats page title", () => {
    const html = generateStatsHtml(null, "now");
    expect(html).toContain("<title>Bloom Cycle Stats</title>");
  });

  it("shows placeholder message when stats is null", () => {
    const html = generateStatsHtml(null, "now");
    expect(html).toContain("No stats available yet.");
  });

  it("renders stats table when stats provided", () => {
    const html = generateStatsHtml(sampleStats, "now");
    expect(html).toContain("100");     // totalCycles
    expect(html).toContain("75%");     // successRate
    expect(html).toContain("$4.50");   // totalCostUsd
  });

  it("includes nav bar with links to other pages", () => {
    const html = generateStatsHtml(null, "now");
    expect(html).toContain("index.html");
    expect(html).toContain("journal.html");
  });

  it("contains the generatedAt timestamp", () => {
    const html = generateStatsHtml(null, "2025-09-01");
    expect(html).toContain("2025-09-01");
  });

  it("returns a complete HTML document", () => {
    const html = generateStatsHtml(null, "now");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });
});

// ---------------------------------------------------------------------------
// STATUS_COLOR constants — value-pinning tests
// ---------------------------------------------------------------------------

describe("STATUS_COLOR constants", () => {
  it("STATUS_COLOR_BACKLOG is the expected gray hex", () => {
    expect(STATUS_COLOR_BACKLOG).toBe("#6b7280");
  });

  it("STATUS_COLOR_UP_NEXT is the expected blue hex", () => {
    expect(STATUS_COLOR_UP_NEXT).toBe("#2563eb");
  });

  it("STATUS_COLOR_IN_PROGRESS is the expected amber hex", () => {
    expect(STATUS_COLOR_IN_PROGRESS).toBe("#d97706");
  });

  it("STATUS_COLOR_DONE is the expected green hex", () => {
    expect(STATUS_COLOR_DONE).toBe("#16a34a");
  });

  it("STATUS_COLORS map uses the named constants", () => {
    expect(STATUS_COLORS["Backlog"]).toBe(STATUS_COLOR_BACKLOG);
    expect(STATUS_COLORS["Up Next"]).toBe(STATUS_COLOR_UP_NEXT);
    expect(STATUS_COLORS["In Progress"]).toBe(STATUS_COLOR_IN_PROGRESS);
    expect(STATUS_COLORS["Done"]).toBe(STATUS_COLOR_DONE);
  });
});
