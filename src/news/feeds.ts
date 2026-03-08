import Parser from "rss-parser";

export interface FeedSource {
  name: string;
  url: string;
  category: "general" | "research" | "industry" | "policy";
}

export interface RawArticle {
  title: string;
  link: string;
  snippet: string;
  source: string;
  category: FeedSource["category"];
  publishedAt: string;
}

export const DEFAULT_FEEDS: FeedSource[] = [
  { name: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/", category: "industry" },
  { name: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", category: "industry" },
  { name: "MIT Tech Review AI", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed", category: "general" },
  { name: "Ars Technica AI", url: "https://feeds.arstechnica.com/arstechnica/technology-lab", category: "general" },
  { name: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed/", category: "industry" },
  { name: "ArXiv CS.AI", url: "http://export.arxiv.org/rss/cs.AI", category: "research" },
  { name: "ArXiv CS.CL", url: "http://export.arxiv.org/rss/cs.CL", category: "research" },
  { name: "AI News (Google)", url: "https://news.google.com/rss/search?q=artificial+intelligence&hl=en-US&gl=US&ceid=US:en", category: "general" },
];

export async function fetchFeed(source: FeedSource, timeoutMs = 10000): Promise<RawArticle[]> {
  const parser = new Parser({ timeout: timeoutMs });
  const feed = await parser.parseURL(source.url);

  return (feed.items ?? []).map((item) => ({
    title: item.title?.trim() ?? "Untitled",
    link: item.link ?? "",
    snippet: stripHtml(item.contentSnippet ?? item.content ?? "").slice(0, 500),
    source: source.name,
    category: source.category,
    publishedAt: item.isoDate ?? item.pubDate ?? new Date().toISOString(),
  }));
}

export type FeedFetcher = (source: FeedSource) => Promise<RawArticle[]>;

export async function fetchAllFeeds(
  feeds: FeedSource[] = DEFAULT_FEEDS,
  maxAgeHours = 24,
  fetcher: FeedFetcher = fetchFeed,
): Promise<RawArticle[]> {
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  const results: RawArticle[] = [];

  const settled = await Promise.allSettled(feeds.map((f) => fetcher(f)));

  for (const result of settled) {
    if (result.status === "fulfilled") {
      results.push(...result.value);
    } else {
      console.warn(`[feeds] Feed failed: ${result.reason}`);
    }
  }

  // Filter to recent articles and deduplicate by link
  const seen = new Set<string>();
  return results
    .filter((a) => {
      const pubTime = new Date(a.publishedAt).getTime();
      return !isNaN(pubTime) ? pubTime >= cutoff : true;
    })
    .filter((a) => {
      if (seen.has(a.link)) return false;
      seen.add(a.link);
      return true;
    })
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}
