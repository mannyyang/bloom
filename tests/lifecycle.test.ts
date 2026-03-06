import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);

import {
  runPreflightCheck,
  setGitBotIdentity,
  commitCycleCount,
  pushChanges,
} from "../src/lifecycle.js";

describe("lifecycle helpers", () => {
  beforeEach(() => {
    mockedExecSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("runPreflightCheck", () => {
    it("returns true when build+test succeeds", () => {
      mockedExecSync.mockReturnValue(Buffer.from(""));
      expect(runPreflightCheck()).toBe(true);
      expect(mockedExecSync).toHaveBeenCalledWith(
        "pnpm build && pnpm test",
        expect.objectContaining({ timeout: 120_000 }),
      );
    });

    it("returns false when build+test fails", () => {
      mockedExecSync.mockImplementation(() => { throw new Error("build failed"); });
      expect(runPreflightCheck()).toBe(false);
    });
  });

  describe("setGitBotIdentity", () => {
    it("sets all four git env vars", () => {
      setGitBotIdentity();
      expect(process.env.GIT_AUTHOR_NAME).toBe("bloom[bot]");
      expect(process.env.GIT_AUTHOR_EMAIL).toBe("bloom[bot]@users.noreply.github.com");
      expect(process.env.GIT_COMMITTER_NAME).toBe("bloom[bot]");
      expect(process.env.GIT_COMMITTER_EMAIL).toBe("bloom[bot]@users.noreply.github.com");
    });
  });

  describe("commitCycleCount", () => {
    it("returns true on successful commit", () => {
      mockedExecSync.mockReturnValue(Buffer.from(""));
      expect(commitCycleCount(42)).toBe(true);
      expect(mockedExecSync).toHaveBeenCalledWith(
        'git add CYCLE_COUNT && git commit -m "cycle 42"',
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it("returns false when commit fails", () => {
      mockedExecSync.mockImplementation(() => { throw new Error("nothing to commit"); });
      expect(commitCycleCount(42)).toBe(false);
    });
  });

  describe("pushChanges", () => {
    it("returns true on successful push", () => {
      mockedExecSync.mockReturnValue(Buffer.from(""));
      expect(pushChanges()).toBe(true);
      expect(mockedExecSync).toHaveBeenCalledWith(
        "git push origin main",
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it("returns false when push fails", () => {
      mockedExecSync.mockImplementation(() => { throw new Error("push rejected"); });
      expect(pushChanges()).toBe(false);
    });
  });
});
