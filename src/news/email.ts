import type { CuratedDigest } from "./curate.js";
import { formatDigestAsHtml } from "./format.js";

export interface EmailConfig {
  to: string;
  from?: string;
  provider: "resend" | "sendgrid" | "smtp";
  apiKey?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
}

export function getEmailConfigFromEnv(): EmailConfig | null {
  const to = process.env.NEWS_EMAIL_TO;
  if (!to) return null;

  const provider = (process.env.NEWS_EMAIL_PROVIDER ?? "resend") as EmailConfig["provider"];

  return {
    to,
    from: process.env.NEWS_EMAIL_FROM ?? "Bloom AI Digest <digest@bloom.ai>",
    provider,
    apiKey: process.env.NEWS_EMAIL_API_KEY,
    smtpHost: process.env.NEWS_SMTP_HOST,
    smtpPort: process.env.NEWS_SMTP_PORT ? parseInt(process.env.NEWS_SMTP_PORT, 10) : undefined,
    smtpUser: process.env.NEWS_SMTP_USER,
    smtpPass: process.env.NEWS_SMTP_PASS,
  };
}

export async function sendDigestEmail(digest: CuratedDigest, config: EmailConfig): Promise<boolean> {
  const html = formatDigestAsHtml(digest);
  const subject = `AI News Digest — ${digest.date} (${digest.stories.length} stories)`;

  switch (config.provider) {
    case "resend":
      return sendViaResend(subject, html, config);
    case "sendgrid":
      return sendViaSendGrid(subject, html, config);
    case "smtp":
      console.log("[email] SMTP provider not yet implemented. Email content written to stdout.");
      console.log(`Subject: ${subject}\nTo: ${config.to}\n`);
      return false;
    default:
      console.error(`[email] Unknown provider: ${config.provider}`);
      return false;
  }
}

async function sendViaResend(subject: string, html: string, config: EmailConfig): Promise<boolean> {
  if (!config.apiKey) {
    console.error("[email] Missing NEWS_EMAIL_API_KEY for Resend");
    return false;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.from,
      to: [config.to],
      subject,
      html,
    }),
  });

  if (response.ok) {
    console.log("[email] Sent via Resend successfully.");
    return true;
  }

  const errorText = await response.text();
  console.error(`[email] Resend API error (${response.status}): ${errorText}`);
  return false;
}

async function sendViaSendGrid(subject: string, html: string, config: EmailConfig): Promise<boolean> {
  if (!config.apiKey) {
    console.error("[email] Missing NEWS_EMAIL_API_KEY for SendGrid");
    return false;
  }

  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: config.to }] }],
      from: { email: config.from },
      subject,
      content: [{ type: "text/html", value: html }],
    }),
  });

  if (response.ok || response.status === 202) {
    console.log("[email] Sent via SendGrid successfully.");
    return true;
  }

  const errorText = await response.text();
  console.error(`[email] SendGrid API error (${response.status}): ${errorText}`);
  return false;
}
