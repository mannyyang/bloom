import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  parseRoadmapSections,
  renderSection,
  renderStatsSection,
  renderJournalSection,
  renderJournalCards,
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

  it("accordion details element has open attribute", () => {
    const html = renderJournalCards([sampleEntry]);
    expect(html).toContain('<details class="journal-card" open>');
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
