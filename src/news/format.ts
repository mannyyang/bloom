import type { CuratedDigest } from "./curate.js";

export function formatDigestAsHtml(digest: CuratedDigest): string {
  const storiesHtml = digest.stories
    .map(
      (story) => `
    <div style="margin-bottom: 24px; padding: 16px; background: #f8f9fa; border-radius: 8px; border-left: 4px solid ${categoryColor(story.category)};">
      <h3 style="margin: 0 0 8px 0; color: #1a1a1a; font-size: 18px;">${escapeHtml(story.headline)}</h3>
      <span style="display: inline-block; padding: 2px 8px; background: ${categoryColor(story.category)}20; color: ${categoryColor(story.category)}; border-radius: 4px; font-size: 12px; font-weight: 600; margin-bottom: 8px;">${escapeHtml(story.category.toUpperCase())}</span>
      <p style="margin: 8px 0; color: #333; line-height: 1.5;">${escapeHtml(story.summary)}</p>
      <p style="margin: 8px 0; color: #666; font-style: italic; font-size: 14px;">Why it matters: ${escapeHtml(story.significance)}</p>
      <div style="margin-top: 8px; font-size: 13px;">
        ${story.sources.map((s) => `<a href="${escapeHtml(s.url)}" style="color: #0066cc; margin-right: 12px;">${escapeHtml(s.name)}</a>`).join("")}
      </div>
    </div>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 680px; margin: 0 auto; padding: 20px; background: #ffffff; color: #1a1a1a;">
  <div style="text-align: center; padding: 20px 0; border-bottom: 2px solid #e0e0e0; margin-bottom: 24px;">
    <h1 style="margin: 0; font-size: 28px; color: #1a1a1a;">AI News Digest</h1>
    <p style="margin: 4px 0 0 0; color: #666; font-size: 14px;">${escapeHtml(digest.date)} · ${digest.rawArticleCount} articles scanned · ${digest.stories.length} top stories</p>
  </div>
  <div style="padding: 16px; background: #e8f4f8; border-radius: 8px; margin-bottom: 24px;">
    <p style="margin: 0; color: #333; line-height: 1.6; font-size: 15px;"><strong>Today's Overview:</strong> ${escapeHtml(digest.summary)}</p>
  </div>
  ${storiesHtml}
  <div style="text-align: center; padding: 20px 0; border-top: 2px solid #e0e0e0; margin-top: 24px; color: #999; font-size: 12px;">
    Curated by Bloom AI News Aggregator
  </div>
</body>
</html>`;
}

export function formatDigestAsMarkdown(digest: CuratedDigest): string {
  const stories = digest.stories
    .map(
      (story) =>
        `### ${story.headline}\n**[${story.category.toUpperCase()}]**\n\n${story.summary}\n\n*Why it matters:* ${story.significance}\n\n${story.sources.map((s) => `- [${s.name}](${s.url})`).join("\n")}`,
    )
    .join("\n\n---\n\n");

  return `# AI News Digest — ${digest.date}

*${digest.rawArticleCount} articles scanned · ${digest.stories.length} top stories*

## Overview
${digest.summary}

---

${stories}

---
*Curated by Bloom AI News Aggregator*
`;
}

function categoryColor(category: string): string {
  switch (category) {
    case "research": return "#7c3aed";
    case "industry": return "#0891b2";
    case "policy":   return "#dc2626";
    default:         return "#6b7280";
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
