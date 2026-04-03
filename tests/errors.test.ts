import { describe, it, expect } from "vitest";
import { errorMessage, execSyncOutput } from "../src/errors.js";

describe("errorMessage", () => {
  it("extracts message from Error instances", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("extracts message from Error subclasses", () => {
    expect(errorMessage(new TypeError("type error"))).toBe("type error");
  });

  it("returns string values directly", () => {
    expect(errorMessage("something went wrong")).toBe("something went wrong");
  });

  it("returns 'null' for null", () => {
    expect(errorMessage(null)).toBe("null");
  });

  it("returns 'undefined' for undefined", () => {
    expect(errorMessage(undefined)).toBe("undefined");
  });

  it("extracts message from plain objects with a message property", () => {
    expect(errorMessage({ message: "obj error" })).toBe("obj error");
  });

  it("stringifies objects without a message property", () => {
    expect(errorMessage({ code: 42 })).toBe("[object Object]");
  });

  it("stringifies numbers", () => {
    expect(errorMessage(42)).toBe("42");
  });

  it("handles empty string", () => {
    expect(errorMessage("")).toBe("");
  });

  it("handles objects where message is not a string", () => {
    expect(errorMessage({ message: 123 })).toBe("[object Object]");
  });
});

describe("execSyncOutput", () => {
  it("extracts stdout and stderr from an exec error object", () => {
    const err = { stdout: "out\n", stderr: "err\n" };
    expect(execSyncOutput(err)).toBe("out\nerr");
  });

  it("returns stdout only when stderr is missing", () => {
    expect(execSyncOutput({ stdout: "output" })).toBe("output");
  });

  it("returns stderr only when stdout is missing", () => {
    expect(execSyncOutput({ stderr: "error" })).toBe("error");
  });

  it("returns empty string for null", () => {
    expect(execSyncOutput(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(execSyncOutput(undefined)).toBe("");
  });

  it("returns empty string for non-object types", () => {
    expect(execSyncOutput(42)).toBe("");
    expect(execSyncOutput("string")).toBe("");
    expect(execSyncOutput(true)).toBe("");
  });

  it("converts Buffer stdout/stderr to string", () => {
    expect(execSyncOutput({ stdout: Buffer.from("buf") })).toBe("buf");
    expect(execSyncOutput({ stderr: Buffer.from("err") })).toBe("err");
    expect(execSyncOutput({ stdout: Buffer.from("out"), stderr: Buffer.from("err") })).toBe("outerr");
  });

  it("returns empty string when stdout/stderr are non-string non-Buffer types", () => {
    expect(execSyncOutput({ stdout: 123, stderr: 456 })).toBe("");
  });

  it("returns empty string for empty object", () => {
    expect(execSyncOutput({})).toBe("");
  });

  it("trims whitespace from combined output", () => {
    expect(execSyncOutput({ stdout: "  out  ", stderr: "  err  " })).toBe("out    err");
  });

  it("returns empty string when both stdout and stderr are whitespace-only", () => {
    expect(execSyncOutput({ stdout: "  ", stderr: "  " })).toBe("");
  });
});
