import { describe, it, expect } from "vitest";
import { formatDigestAsHtml, formatDigestAsMarkdown } from "../../src/news/format.js";
import type { CuratedDigest } from "../../src/news/curate.js";

const mockDigest: CuratedDigest = {
  date: "2026-03-08",
  summary: "Today saw major advances in AI safety research and a new model release.",
  rawArticleCount: 42,
  stories: [
    {
      headline: "OpenAI Releases GPT-5",
      summary: "OpenAI announced GPT-5 with improved reasoning capabilities.",
      significance: "Sets new benchmarks across multiple evaluation suites.",
      sources: [
        { name: "TechCrunch", url: "https://techcrunch.com/gpt5" },
        { name: "The Verge", url: "https://theverge.com/gpt5" },
      ],
      category: "industry",
    },
    {
      headline: "New AI Safety Framework Published",
      summary: "Researchers propose a novel framework for evaluating AI alignment.",
      significance: "Could become standard for safety evaluations.",
      sources: [{ name: "ArXiv", url: "https://arxiv.org/safety" }],
      category: "research",
    },
  ],
};

describe("formatDigestAsHtml", () => {
  it("should produce valid HTML with all stories", () => {
    const html = formatDigestAsHtml(mockDigest);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("AI News Digest");
    expect(html).toContain("2026-03-08");
    expect(html).toContain("OpenAI Releases GPT-5");
    expect(html).toContain("New AI Safety Framework Published");
    expect(html).toContain("42 articles scanned");
    expect(html).toContain("2 top stories");
  });

  it("should escape HTML entities in content", () => {
    const xssDigest: CuratedDigest = {
      ...mockDigest,
      summary: '<script>alert("xss")</script>',
      stories: [
        {
          ...mockDigest.stories[0]!,
          headline: '<img onerror="alert(1)" src=x>',
        },
      ],
    };
    const html = formatDigestAsHtml(xssDigest);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('onerror="');
    expect(html).toContain("&lt;script&gt;");
  });

  it("should include source links", () => {
    const html = formatDigestAsHtml(mockDigest);
    expect(html).toContain("https://techcrunch.com/gpt5");
    expect(html).toContain("TechCrunch");
  });
});

describe("formatDigestAsMarkdown", () => {
  it("should produce valid markdown with all stories", () => {
    const md = formatDigestAsMarkdown(mockDigest);
    expect(md).toContain("# AI News Digest — 2026-03-08");
    expect(md).toContain("### OpenAI Releases GPT-5");
    expect(md).toContain("### New AI Safety Framework Published");
    expect(md).toContain("[INDUSTRY]");
    expect(md).toContain("[RESEARCH]");
  });

  it("should include source links as markdown", () => {
    const md = formatDigestAsMarkdown(mockDigest);
    expect(md).toContain("[TechCrunch](https://techcrunch.com/gpt5)");
    expect(md).toContain("[ArXiv](https://arxiv.org/safety)");
  });
});

describe("empty digest", () => {
  it("should handle digest with no stories", () => {
    const emptyDigest: CuratedDigest = {
      date: "2026-03-08",
      summary: "No articles found.",
      rawArticleCount: 0,
      stories: [],
    };
    const html = formatDigestAsHtml(emptyDigest);
    expect(html).toContain("0 articles scanned");
    expect(html).toContain("0 top stories");

    const md = formatDigestAsMarkdown(emptyDigest);
    expect(md).toContain("0 articles scanned");
  });
});
