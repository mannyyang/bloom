import { describe, it, expect, vi } from "vitest";
import { DEFAULT_FEEDS, fetchAllFeeds, type RawArticle, type FeedSource, type FeedFetcher } from "../../src/news/feeds.js";

describe("DEFAULT_FEEDS", () => {
  it("should have at least 5 feed sources", () => {
    expect(DEFAULT_FEEDS.length).toBeGreaterThanOrEqual(5);
  });

  it("should have valid categories for all feeds", () => {
    const validCategories = ["general", "research", "industry", "policy"];
    for (const feed of DEFAULT_FEEDS) {
      expect(validCategories).toContain(feed.category);
    }
  });

  it("should have urls and names for all feeds", () => {
    for (const feed of DEFAULT_FEEDS) {
      expect(feed.name.length).toBeGreaterThan(0);
      expect(feed.url.length).toBeGreaterThan(0);
    }
  });
});

describe("fetchAllFeeds", () => {
  it("should deduplicate articles by link", async () => {
    const now = new Date().toISOString();
    const mockFetcher: FeedFetcher = async () => [
      { title: "Article 1", link: "https://example.com/1", snippet: "Snippet 1", source: "Test", category: "general", publishedAt: now },
      { title: "Article 1 Dupe", link: "https://example.com/1", snippet: "Snippet 1 again", source: "Test", category: "general", publishedAt: now },
      { title: "Article 2", link: "https://example.com/2", snippet: "Snippet 2", source: "Test", category: "general", publishedAt: now },
    ];

    const articles = await fetchAllFeeds(
      [{ name: "Test", url: "https://example.com/feed", category: "general" }],
      24,
      mockFetcher,
    );
    expect(articles.length).toBe(2);
    expect(articles.map((a) => a.link)).toContain("https://example.com/1");
    expect(articles.map((a) => a.link)).toContain("https://example.com/2");
  });

  it("should filter out articles older than maxAgeHours", async () => {
    const now = new Date();
    const recentDate = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const oldDate = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

    const mockFetcher: FeedFetcher = async () => [
      { title: "Recent", link: "https://example.com/recent", snippet: "New", source: "Test", category: "general", publishedAt: recentDate },
      { title: "Old", link: "https://example.com/old", snippet: "Stale", source: "Test", category: "general", publishedAt: oldDate },
    ];

    const articles = await fetchAllFeeds(
      [{ name: "Test", url: "https://example.com/feed", category: "general" }],
      24,
      mockFetcher,
    );
    expect(articles.length).toBe(1);
    expect(articles[0]!.title).toBe("Recent");
  });

  it("should handle feed failures gracefully", async () => {
    let callCount = 0;
    const mockFetcher: FeedFetcher = async (source) => {
      callCount++;
      if (callCount === 1) throw new Error("Network error");
      return [
        { title: "Works", link: "https://example.com/works", snippet: "OK", source: source.name, category: "general", publishedAt: new Date().toISOString() },
      ];
    };

    const articles = await fetchAllFeeds(
      [
        { name: "Broken", url: "https://broken.com/feed", category: "general" },
        { name: "Works", url: "https://works.com/feed", category: "general" },
      ],
      24,
      mockFetcher,
    );
    expect(articles.length).toBe(1);
    expect(articles[0]!.title).toBe("Works");
  });

  it("should sort articles by date descending", async () => {
    const now = new Date();
    const date1 = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString();
    const date2 = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();
    const date3 = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();

    const mockFetcher: FeedFetcher = async () => [
      { title: "Middle", link: "https://example.com/3", snippet: "", source: "Test", category: "general", publishedAt: date3 },
      { title: "Newest", link: "https://example.com/1", snippet: "", source: "Test", category: "general", publishedAt: date1 },
      { title: "Oldest", link: "https://example.com/2", snippet: "", source: "Test", category: "general", publishedAt: date2 },
    ];

    const articles = await fetchAllFeeds(
      [{ name: "Test", url: "https://example.com/feed", category: "general" }],
      24,
      mockFetcher,
    );
    expect(articles.map((a) => a.title)).toEqual(["Newest", "Middle", "Oldest"]);
  });
});
