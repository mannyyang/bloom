import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getEmailConfigFromEnv, sendDigestEmail } from "../../src/news/email.js";
import type { CuratedDigest } from "../../src/news/curate.js";

const mockDigest: CuratedDigest = {
  date: "2026-03-08",
  summary: "Test digest",
  rawArticleCount: 10,
  stories: [
    {
      headline: "Test Story",
      summary: "A test story",
      significance: "Testing",
      sources: [{ name: "Test", url: "https://test.com" }],
      category: "general",
    },
  ],
};

describe("getEmailConfigFromEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return null when NEWS_EMAIL_TO is not set", () => {
    delete process.env.NEWS_EMAIL_TO;
    expect(getEmailConfigFromEnv()).toBeNull();
  });

  it("should return config with defaults when NEWS_EMAIL_TO is set", () => {
    process.env.NEWS_EMAIL_TO = "user@example.com";
    const config = getEmailConfigFromEnv();
    expect(config).not.toBeNull();
    expect(config!.to).toBe("user@example.com");
    expect(config!.provider).toBe("resend");
    expect(config!.from).toContain("Bloom AI Digest");
  });

  it("should use custom provider when specified", () => {
    process.env.NEWS_EMAIL_TO = "user@example.com";
    process.env.NEWS_EMAIL_PROVIDER = "sendgrid";
    const config = getEmailConfigFromEnv();
    expect(config!.provider).toBe("sendgrid");
  });
});

describe("sendDigestEmail", () => {
  it("should fail when API key is missing for resend", async () => {
    const config = { to: "user@example.com", provider: "resend" as const };
    const result = await sendDigestEmail(mockDigest, config);
    expect(result).toBe(false);
  });

  it("should fail when API key is missing for sendgrid", async () => {
    const config = { to: "user@example.com", provider: "sendgrid" as const };
    const result = await sendDigestEmail(mockDigest, config);
    expect(result).toBe(false);
  });

  it("should call Resend API with correct payload", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("{}") });
    vi.stubGlobal("fetch", mockFetch);

    const config = {
      to: "user@example.com",
      from: "digest@bloom.ai",
      provider: "resend" as const,
      apiKey: "re_test_key",
    };

    const result = await sendDigestEmail(mockDigest, config);
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(options.method).toBe("POST");

    const body = JSON.parse(options.body);
    expect(body.to).toEqual(["user@example.com"]);
    expect(body.subject).toContain("AI News Digest");

    vi.unstubAllGlobals();
  });

  it("should call SendGrid API with correct payload", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 202, text: () => Promise.resolve("") });
    vi.stubGlobal("fetch", mockFetch);

    const config = {
      to: "user@example.com",
      from: "digest@bloom.ai",
      provider: "sendgrid" as const,
      apiKey: "SG.test_key",
    };

    const result = await sendDigestEmail(mockDigest, config);
    expect(result).toBe(true);

    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(JSON.parse(options.body).personalizations[0].to[0].email).toBe("user@example.com");

    vi.unstubAllGlobals();
  });
});
