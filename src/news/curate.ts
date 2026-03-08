import { query } from "@anthropic-ai/claude-agent-sdk";
import type { RawArticle } from "./feeds.js";

export interface CuratedDigest {
  date: string;
  summary: string;
  stories: CuratedStory[];
  rawArticleCount: number;
}

export interface CuratedStory {
  headline: string;
  summary: string;
  significance: string;
  sources: { name: string; url: string }[];
  category: string;
}

export async function curateDigest(articles: RawArticle[]): Promise<CuratedDigest> {
  const today = new Date().toISOString().split("T")[0]!;

  if (articles.length === 0) {
    return {
      date: today,
      summary: "No AI news articles were found for today.",
      stories: [],
      rawArticleCount: 0,
    };
  }

  const articleList = articles
    .slice(0, 100) // cap to avoid prompt bloat
    .map(
      (a, i) =>
        `[${i + 1}] "${a.title}" — ${a.source} (${a.category})\n    ${a.link}\n    ${a.snippet.slice(0, 200)}`,
    )
    .join("\n\n");

  const prompt = `You are an expert AI news curator. Analyze the following ${articles.length} articles and produce a curated daily digest.

## Articles
${articleList}

## Instructions
1. Group related articles about the same topic together
2. Select the 5-10 most important/significant stories
3. Write a concise 2-3 sentence summary for each story
4. Explain why each story matters (significance)
5. Write a brief overall summary of today's AI news landscape (2-3 sentences)

## Output Format
Respond with ONLY valid JSON matching this structure (no markdown, no code fences):
{
  "summary": "Overall summary of today's AI news...",
  "stories": [
    {
      "headline": "Clear headline for the story",
      "summary": "2-3 sentence summary of the story",
      "significance": "Why this matters",
      "sources": [{"name": "Source Name", "url": "https://..."}],
      "category": "research|industry|policy|general"
    }
  ]
}

Prioritize: major model releases, significant research breakthroughs, policy/regulation changes, major company moves, and industry trends. Skip fluff and listicles.`;

  let result = "";
  for await (const msg of query({
    prompt,
    options: {
      model: "claude-sonnet-4-6",
      maxTurns: 1,
      maxBudgetUsd: 0.5,
    },
  })) {
    if ("result" in msg) result = msg.result;
  }

  const parsed = parseDigestResponse(result);
  return {
    date: today,
    summary: parsed.summary,
    stories: parsed.stories,
    rawArticleCount: articles.length,
  };
}

function parseDigestResponse(text: string): { summary: string; stories: CuratedStory[] } {
  // Try to extract JSON from the response
  let jsonStr = text.trim();

  // Remove markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1]!.trim();
  }

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      summary: parsed.summary ?? "No summary available.",
      stories: (parsed.stories ?? []).map((s: Record<string, unknown>) => ({
        headline: (s.headline as string) ?? "Untitled",
        summary: (s.summary as string) ?? "",
        significance: (s.significance as string) ?? "",
        sources: (s.sources as CuratedStory["sources"]) ?? [],
        category: (s.category as string) ?? "general",
      })),
    };
  } catch {
    return {
      summary: "Failed to parse curated digest. Raw output:\n" + text.slice(0, 1000),
      stories: [],
    };
  }
}
