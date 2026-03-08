import { readFileSync } from "fs";
import { createSign } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const APP_ID = "3021184";
const INSTALLATION_ID = "114372557";
const __dirname = dirname(fileURLToPath(import.meta.url));

function getPrivateKey(): string {
  if (process.env.BLOOM_APP_PRIVATE_KEY) {
    return process.env.BLOOM_APP_PRIVATE_KEY;
  }
  const pemPath = process.env.BLOOM_PEM_PATH
    ? resolve(process.env.BLOOM_PEM_PATH)
    : resolve(__dirname, "../bloom-bot-agent.2026-03-05.private-key.pem");
  return readFileSync(pemPath, "utf-8");
}

function createJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: APP_ID }),
  ).toString("base64url");

  const privateKey = getPrivateKey();
  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(privateKey, "base64url");

  return `${header}.${payload}.${signature}`;
}

let cachedToken: { token: string; expiresAt: number } | null = null;
let pendingRequest: Promise<string> | null = null;

export async function getInstallationToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  if (pendingRequest) {
    return pendingRequest;
  }

  pendingRequest = (async () => {
    const jwt = createJwt();
    const res = await fetch(
      `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!res.ok) {
      throw new Error(`Failed to get installation token: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as { token: string; expires_at: string };
    cachedToken = {
      token: data.token,
      expiresAt: new Date(data.expires_at).getTime() - 60_000,
    };
    return cachedToken.token;
  })().finally(() => {
    pendingRequest = null;
  });

  return pendingRequest;
}

export async function githubApiRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  const token = await getInstallationToken();
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function githubGraphQL(
  query: string,
  variables?: Record<string, unknown>,
): Promise<Record<string, any>> {
  const token = await getInstallationToken();
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`GraphQL request failed: ${res.status} ${await res.text()}`);
  }

  return (await res.json()) as Record<string, any>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
