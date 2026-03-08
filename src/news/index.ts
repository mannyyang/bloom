import { fetchAllFeeds, DEFAULT_FEEDS, type FeedSource } from "./feeds.js";
import { curateDigest } from "./curate.js";
import { formatDigestAsMarkdown } from "./format.js";
import { sendDigestEmail, getEmailConfigFromEnv } from "./email.js";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

async function main() {
  const startTime = Date.now();
  console.log("\n========================================");
  console.log("  Bloom AI News Aggregator");
  console.log(`  ${new Date().toISOString()}`);
  console.log("========================================\n");

  // 1. Load custom feeds from env, or use defaults
  const customFeedUrls = process.env.NEWS_EXTRA_FEEDS;
  const feeds: FeedSource[] = [...DEFAULT_FEEDS];
  if (customFeedUrls) {
    for (const url of customFeedUrls.split(",")) {
      feeds.push({ name: "Custom", url: url.trim(), category: "general" });
    }
  }

  // 2. Fetch articles from all feeds
  console.log(`[fetch] Fetching from ${feeds.length} sources...`);
  const maxAgeHours = parseInt(process.env.NEWS_MAX_AGE_HOURS ?? "24", 10);
  const articles = await fetchAllFeeds(feeds, maxAgeHours);
  console.log(`[fetch] Collected ${articles.length} articles from last ${maxAgeHours}h`);

  if (articles.length === 0) {
    console.log("[fetch] No articles found. Exiting.");
    return;
  }

  // Log source breakdown
  const sourceCounts = new Map<string, number>();
  for (const a of articles) {
    sourceCounts.set(a.source, (sourceCounts.get(a.source) ?? 0) + 1);
  }
  for (const [source, count] of sourceCounts) {
    console.log(`  - ${source}: ${count} articles`);
  }

  // 3. Curate with Claude
  console.log("\n[curate] Sending to Claude for curation...");
  const digest = await curateDigest(articles);
  console.log(`[curate] Digest ready: ${digest.stories.length} stories curated from ${digest.rawArticleCount} articles`);

  for (const story of digest.stories) {
    console.log(`  - [${story.category}] ${story.headline}`);
  }

  // 4. Output digest
  const markdown = formatDigestAsMarkdown(digest);

  // Write to file
  const outputDir = join(process.cwd(), "digests");
  mkdirSync(outputDir, { recursive: true });
  const outputFile = join(outputDir, `${digest.date}.md`);
  writeFileSync(outputFile, markdown);
  console.log(`\n[output] Digest written to ${outputFile}`);

  // 5. Send email (if configured)
  const emailConfig = getEmailConfigFromEnv();
  if (emailConfig) {
    console.log(`[email] Sending digest to ${emailConfig.to}...`);
    const sent = await sendDigestEmail(digest, emailConfig);
    if (sent) {
      console.log("[email] Digest email sent successfully.");
    } else {
      console.error("[email] Failed to send digest email.");
    }
  } else {
    console.log("[email] No email configured (set NEWS_EMAIL_TO to enable).");
  }

  const totalMs = Date.now() - startTime;
  console.log(`\n========================================`);
  console.log(`  Digest Complete — ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  ${digest.stories.length} stories from ${digest.rawArticleCount} articles`);
  console.log(`========================================\n`);

  // Print markdown to stdout for easy consumption
  console.log(markdown);
}

main().catch((err) => {
  console.error("News aggregator failed:", err);
  process.exit(1);
});
