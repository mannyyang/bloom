import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs and crypto before importing the module
vi.mock("fs", () => ({
  readFileSync: vi.fn().mockReturnValue("fake-pem-key"),
}));

vi.mock("crypto", () => {
  const mockSign = {
    update: vi.fn(),
    sign: vi.fn().mockReturnValue("fake-signature"),
  };
  return { createSign: vi.fn().mockReturnValue(mockSign) };
});

// We need to dynamically import the module to reset cached state between tests.
async function loadModule() {
  const mod = await import("../src/github-app.js");
  return mod;
}

describe("github-app", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    // Re-apply mocks after resetModules
    vi.mock("fs", () => ({
      readFileSync: vi.fn().mockReturnValue("fake-pem-key"),
    }));
    vi.mock("crypto", () => {
      const mockSign = {
        update: vi.fn(),
        sign: vi.fn().mockReturnValue("fake-signature"),
      };
      return { createSign: vi.fn().mockReturnValue(mockSign) };
    });

    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  describe("getInstallationToken", () => {
    it("fetches a new token from the GitHub API", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "ghs_test123",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
      });

      const { getInstallationToken } = await loadModule();
      const token = await getInstallationToken();

      expect(token).toBe("ghs_test123");
      expect(mockFetch).toHaveBeenCalledOnce();
      // Verify it called the correct endpoint
      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain("/app/installations/");
      expect(callUrl).toContain("/access_tokens");
      // Verify POST method and Bearer auth
      const callOpts = mockFetch.mock.calls[0][1] as RequestInit;
      expect(callOpts.method).toBe("POST");
      expect((callOpts.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
    });

    it("returns cached token on subsequent calls", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "ghs_cached",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
      });

      const { getInstallationToken } = await loadModule();
      const first = await getInstallationToken();
      const second = await getInstallationToken();

      expect(first).toBe("ghs_cached");
      expect(second).toBe("ghs_cached");
      // fetch should only be called once — second call uses cache
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it("fetches a new token when the cached token has expired", async () => {
      // First call: return a token that expires in the past
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "ghs_expired",
          // expires_at in the past — the 60s safety margin in the code makes this already expired
          expires_at: new Date(Date.now() - 60_000).toISOString(),
        }),
      });
      // Second call: return a fresh token
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "ghs_refreshed",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
      });

      const { getInstallationToken } = await loadModule();
      const first = await getInstallationToken();
      expect(first).toBe("ghs_expired");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call should detect the expired cache and fetch again
      const second = await getInstallationToken();
      expect(second).toBe("ghs_refreshed");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("throws when fetch itself rejects (network error)", async () => {
      mockFetch.mockRejectedValueOnce(new Error("DNS resolution failed"));

      const { getInstallationToken } = await loadModule();
      await expect(getInstallationToken()).rejects.toThrow("DNS resolution failed");
    });

    it("does not cache a failed attempt and retries on next call", async () => {
      // First call: fetch rejects (network error)
      mockFetch.mockRejectedValueOnce(new Error("Network timeout"));
      // Second call: fetch succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "ghs_retry_success",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
      });

      const { getInstallationToken } = await loadModule();

      // First call should fail
      await expect(getInstallationToken()).rejects.toThrow("Network timeout");

      // Second call should retry and succeed (not return stale error)
      const token = await getInstallationToken();
      expect(token).toBe("ghs_retry_success");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("passes an abort signal with timeout to fetch", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "ghs_timeout",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
      });

      const { getInstallationToken } = await loadModule();
      await getInstallationToken();

      const callOpts = mockFetch.mock.calls[0][1] as RequestInit;
      expect(callOpts.signal).toBeInstanceOf(AbortSignal);
    });

    it("throws when the API returns a non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });

      const { getInstallationToken } = await loadModule();
      await expect(getInstallationToken()).rejects.toThrow(
        /Failed to get installation token: 401/,
      );
    });
  });

  describe("githubApiRequest", () => {
    // Helper: prime the token cache so githubApiRequest doesn't need
    // a separate fetch for getInstallationToken.
    async function setupWithToken() {
      // First call = getInstallationToken, second = the actual API call
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            token: "ghs_api",
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 1 }),
        });
      return loadModule();
    }

    it("sends GET requests with correct headers and no body", async () => {
      const { githubApiRequest } = await setupWithToken();
      const res = await githubApiRequest("GET", "/repos/owner/repo/issues");

      // Second fetch call is the API request
      const [url, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
      expect(url).toBe("https://api.github.com/repos/owner/repo/issues");
      expect(opts.method).toBe("GET");
      expect((opts.headers as Record<string, string>).Authorization).toBe("token ghs_api");
      expect((opts.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
      expect(opts.body).toBeUndefined();
    });

    it("sends POST requests with JSON body and Content-Type header", async () => {
      const { githubApiRequest } = await setupWithToken();
      await githubApiRequest("POST", "/repos/owner/repo/issues", {
        title: "Test",
        body: "Hello",
      });

      const [, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
      expect(opts.method).toBe("POST");
      expect((opts.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      expect(JSON.parse(opts.body as string)).toEqual({
        title: "Test",
        body: "Hello",
      });
    });

    it("passes an abort signal with timeout to fetch", async () => {
      const { githubApiRequest } = await setupWithToken();
      await githubApiRequest("GET", "/repos/owner/repo");

      // Second fetch call is the API request
      const [, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    });

    it("includes GitHub API version header", async () => {
      const { githubApiRequest } = await setupWithToken();
      await githubApiRequest("GET", "/repos/owner/repo");

      const [, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
      expect((opts.headers as Record<string, string>)["X-GitHub-Api-Version"]).toBe("2022-11-28");
    });
  });
});
