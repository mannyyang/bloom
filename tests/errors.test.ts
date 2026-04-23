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

  it("returns JSON representation for objects without a message property", () => {
    expect(errorMessage({ code: 42 })).toBe('{"code":42}');
  });

  it("returns JSON representation for nested objects", () => {
    expect(errorMessage({ status: 404, detail: "not found" })).toBe('{"status":404,"detail":"not found"}');
  });

  it("stringifies numbers", () => {
    expect(errorMessage(42)).toBe("42");
  });

  it("handles empty string", () => {
    expect(errorMessage("")).toBe("");
  });

  it("returns JSON for objects where message is not a string", () => {
    expect(errorMessage({ message: 123 })).toBe('{"message":123}');
  });

  it("falls back to String() for circular-reference objects that cannot be JSON-stringified", () => {
    // JSON.stringify throws a TypeError on circular references; the catch branch
    // must return String(err) which produces "[object Object]".
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(errorMessage(o)).toBe("[object Object]");
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
    expect(execSyncOutput({ stdout: Buffer.from("out"), stderr: Buffer.from("err") })).toBe("out\nerr");
  });

  it("returns empty string when stdout/stderr are non-string non-Buffer types", () => {
    expect(execSyncOutput({ stdout: 123, stderr: 456 })).toBe("");
  });

  it("returns empty string for empty object", () => {
    expect(execSyncOutput({})).toBe("");
  });

  it("trims whitespace from combined output", () => {
    expect(execSyncOutput({ stdout: "  out  ", stderr: "  err  " })).toBe("out\nerr");
  });

  it("returns empty string when both stdout and stderr are whitespace-only", () => {
    expect(execSyncOutput({ stdout: "  ", stderr: "  " })).toBe("");
  });

  it("returns empty string when stdout property exists but is null", () => {
    // SpawnError objects can have stdout: null when the process never produced output.
    // toStr(null) must return "" rather than throwing or misformatting.
    expect(execSyncOutput({ stdout: null })).toBe("");
  });

  it("returns empty string when stderr property exists but is null", () => {
    expect(execSyncOutput({ stderr: null })).toBe("");
  });

  it("returns empty string when both stdout and stderr are null", () => {
    expect(execSyncOutput({ stdout: null, stderr: null })).toBe("");
  });
});
