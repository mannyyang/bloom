import { describe, it, expect } from "vitest";
import { CYCLE_STATS_HISTORY_LIMIT, RECENT_FAILURES_WINDOW } from "../src/db.js";
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
  PAGE_STATS_HISTORY_CYCLES,
  PAGE_RECENT_FAILURES_WINDOW,
  GITHUB_REPO_URL,
} from "../src/page-helpers.js";
import type { DbStats, JournalEntry, RoadmapSection } from "../src/page-helpers.js";

// ---------------------------------------------------------------------------
// PAGE_STATS_HISTORY_CYCLES / PAGE_RECENT_FAILURES_WINDOW sync pins
// ---------------------------------------------------------------------------

describe("PAGE_STATS_HISTORY_CYCLES", () => {
  it("equals CYCLE_STATS_HISTORY_LIMIT from db.ts (must-match sync pin)", () => {
    // page-helpers.ts declares this constant with a comment that it must match
    // CYCLE_STATS_HISTORY_LIMIT in db.ts. This test enforces that contract so
    // a change to either value without updating the other is caught immediately.
    expect(PAGE_STATS_HISTORY_CYCLES).toBe(CYCLE_STATS_HISTORY_LIMIT);
  });
});

describe("PAGE_RECENT_FAILURES_WINDOW", () => {
  it("equals RECENT_FAILURES_WINDOW from db.ts (must-match sync pin)", () => {
    // Mirrors the PAGE_STATS_HISTORY_CYCLES sync pin above; page-helpers.ts
    // documents that this value must stay in sync with RECENT_FAILURES_WINDOW
    // in db.ts so the rendered HTML label always matches the actual query window.
    expect(PAGE_RECENT_FAILURES_WINDOW).toBe(RECENT_FAILURES_WINDOW);
  });
});

// ---------------------------------------------------------------------------
// GITHUB_REPO_URL
// ---------------------------------------------------------------------------

describe("GITHUB_REPO_URL", () => {
  it("has the expected value (value-pin)", () => {
    expect(GITHUB_REPO_URL).toBe("https://github.com/mannyyang/bloom");
  });

  it("is used in renderSection issue links", () => {
    const section = {
      heading: "Backlog",
      items: [{ done: false, title: "Test", issueNumber: 42, description: "" }],
    };
    const html = renderSection(section);
    expect(html).toContain(`${GITHUB_REPO_URL}/issues/42`);
  });
});

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

  it("parses an uppercase [X] checked item as done (GitHub renders both)", () => {
    const md = `## Done\n- [X] Completed with capital X\n`;
    const sections = parseRoadmapSections(md);
    expect(sections[0].items[0].done).toBe(true);
    expect(sections[0].items[0].title).toBe("Completed with capital X");
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

  it("skips [since:N] lines without space after colon (regex uses \\s*)", () => {
    const md = `## Done\n- [x] Old task\n  [since:42]\n`;
    const sections = parseRoadmapSections(md);
    expect(sections[0].items[0].description).toBe("");
  });

  it("skips [since: N] annotation but accumulates following description lines", () => {
    const md = `## Done\n- [x] Old task\n  [since: 10]\n  Actual description.\n`;
    const sections = parseRoadmapSections(md);
    expect(sections[0].items[0].description).toBe("Actual description.");
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

  it("strips …[truncated] storage marker from description", () => {
    const md = `## Backlog\n- [ ] Long task\n  Some body text …[truncated]\n`;
    const sections = parseRoadmapSections(md);
    expect(sections[0].items[0].description).toBe("Some body text");
    expect(sections[0].items[0].description).not.toContain("…[truncated]");
  });

  it("strips …[truncated] from description — renderSection HTML contains no marker", () => {
    const md = `## Backlog\n- [ ] Long task\n  Some body text …[truncated]\n`;
    const sections = parseRoadmapSections(md);
    const html = renderSection(sections[0]);
    expect(html).not.toContain("…[truncated]");
  });

  it("### sub-heading inside a section does not create a new section and does not appear in descriptions", () => {
    // The heading regex is /^##\s+/ which requires exactly two '#' followed by
    // whitespace. A '###' line has a third '#' where whitespace is expected, so
    // it does not match and falls through. It also fails /^\s{2,}/ (no leading
    // spaces) so it is silently dropped — correct behaviour. This test ensures
    // a ### line in a real ROADMAP.md can never silently inflate the section
    // count or leak raw '###' text into an item description.
    const md = `## Backlog\n- [ ] Task A\n### Sub-heading\n- [ ] Task B\n`;
    const sections = parseRoadmapSections(md);
    // Must still be exactly one section (the ## Backlog one)
    expect(sections).toHaveLength(1);
    // The ### line must not become a new section heading
    expect(sections[0].heading).toBe("Backlog");
    // Items must not include the ### line text as a description
    expect(sections[0].items[0].description).not.toContain("Sub-heading");
    expect(sections[0].items[1]?.description ?? "").not.toContain("Sub-heading");
    // The raw '###' string itself must not appear anywhere in item descriptions
    for (const item of sections[0].items) {
      expect(item.description).not.toContain("###");
    }
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

  it("issue link uses mannyyang/bloom repo URL (regression: was anthropics/bloom)", () => {
    const section: RoadmapSection = {
      heading: "Up Next",
      items: [{ done: false, title: "My task", issueNumber: 42, description: "" }],
    };
    const html = renderSection(section);
    expect(html).toContain("https://github.com/mannyyang/bloom/issues/42");
    expect(html).not.toContain("anthropics/bloom");
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

  it("uses fallback color #374151 for unknown section heading not in STATUS_COLORS", () => {
    // Pins the ?? "#374151" fallback in renderSection so silent color drift for
    // future headings (e.g. "Archived", "Blocked") is caught immediately.
    const section: RoadmapSection = {
      heading: "Archived",
      items: [{ done: false, title: "Old feature", issueNumber: null, description: "" }],
    };
    const html = renderSection(section);
    expect(html).toContain("background:#374151");
    expect(html).toContain("Archived");
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
    const row = html.split("\n").find(l => l.includes(`Recent failures (last ${PAGE_RECENT_FAILURES_WINDOW} cycles)`))!;
    expect(row).toBeDefined();
    expect(row).toContain("<strong>1</strong>");
  });

  it("cost row contains exact <strong>$3.14</strong> value when positive", () => {
    const html = renderStatsSection({ ...baseStats, totalCostUsd: 3.14 });
    const row = html.split("\n").find(l => l.includes("Total cost"))!;
    expect(row).toBeDefined();
    expect(row).toContain("<strong>$3.14</strong>");
  });

  it("cost row label uses PAGE_STATS_HISTORY_CYCLES in 'Total cost (last N cycles)' text (label-pin)", () => {
    // Pins the exact label so silent drift in the history-window number is caught.
    // PAGE_STATS_HISTORY_CYCLES must match CYCLE_STATS_HISTORY_LIMIT in db.ts.
    const html = renderStatsSection({ ...baseStats, totalCostUsd: 1.00 });
    expect(html).toContain(`Total cost (last ${PAGE_STATS_HISTORY_CYCLES} cycles)`);
  });

  it("stats-note paragraph uses PAGE_STATS_HISTORY_CYCLES in 'last N evolution cycles' text (label-pin)", () => {
    // Pins the history-window number in the visible note so it stays consistent with db.ts.
    const html = renderStatsSection(baseStats);
    expect(html).toContain(`last ${PAGE_STATS_HISTORY_CYCLES} evolution cycles`);
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

  it("renders card with header but no field divs when all content fields are empty", () => {
    const emptyEntry: JournalEntry = {
      cycleNumber: 7,
      date: "2025-03-01",
      attempted: "",
      succeeded: "",
      failed: "",
      learnings: "",
    };
    const html = renderJournalCards([emptyEntry]);
    // Card wrapper and header must still appear
    expect(html).toContain("journal-card");
    expect(html).toContain("journal-card-header");
    expect(html).toContain("Cycle 7");
    // No label divs should be emitted for empty fields
    expect(html).not.toContain("journal-field");
    expect(html).not.toContain("journal-label");
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

  it("footer contains the github.com/mannyyang/bloom attribution link", () => {
    const html = generateHtml([], "now", "", "");
    expect(html).toContain("github.com/mannyyang/bloom");
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

  it("outer section has class=\"section\" for CSS margin-bottom consistency", () => {
    // The .section rule applies margin-bottom:2rem. Without class="section" on
    // the journal page's outer <section>, the journal body loses its bottom
    // spacing, breaking visual parity with the index and stats pages.
    const html = generateJournalHtml([], "now");
    expect(html).toContain('<section class="section">');
  });

  it("footer contains the github.com/mannyyang/bloom attribution link", () => {
    const html = generateJournalHtml([], "now");
    expect(html).toContain("github.com/mannyyang/bloom");
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

  it("does not show 'No stats available yet.' when real stats are provided", () => {
    const html = generateStatsHtml(sampleStats, "now");
    expect(html).not.toContain("No stats available yet.");
  });

  it("footer contains the github.com/mannyyang/bloom attribution link", () => {
    const html = generateStatsHtml(null, "now");
    expect(html).toContain("github.com/mannyyang/bloom");
  });

  it("null stats branch wraps fallback text in <section class=\"section\"> container", () => {
    // Pins that the no-stats fallback is wrapped in the same section skeleton
    // used by the positive path, so the page layout never collapses when stats
    // are absent (e.g. on the first evolution cycle before any DB rows exist).
    const html = generateStatsHtml(null, "now");
    expect(html).toContain('<section class="section">');
    expect(html).toContain('<p class="stats-note">No stats available yet.</p>');
    // The section must be properly closed
    expect(html).toContain("</section>");
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

// ---------------------------------------------------------------------------
// Mirror-constant sync guards
// ---------------------------------------------------------------------------

describe("PAGE_STATS_HISTORY_CYCLES / PAGE_RECENT_FAILURES_WINDOW sync guards", () => {
  // page-helpers.ts keeps local copies of two db.ts constants to avoid
  // importing the heavyweight db module from a pure-helper module.
  // These tests enforce that the local copies stay in sync with db.ts.
  it("PAGE_STATS_HISTORY_CYCLES matches CYCLE_STATS_HISTORY_LIMIT from db.ts", () => {
    expect(PAGE_STATS_HISTORY_CYCLES).toBe(CYCLE_STATS_HISTORY_LIMIT);
  });

  it("PAGE_RECENT_FAILURES_WINDOW matches RECENT_FAILURES_WINDOW from db.ts", () => {
    expect(PAGE_RECENT_FAILURES_WINDOW).toBe(RECENT_FAILURES_WINDOW);
  });
});
