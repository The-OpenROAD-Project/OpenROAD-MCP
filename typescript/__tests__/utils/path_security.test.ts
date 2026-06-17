import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { validatePathSegment, validateSafePathContainment } from "../../src/utils/path_security.js";
import { ValidationError } from "../../src/exceptions.js";

describe("validatePathSegment", () => {
  it("accepts valid alphanumeric segments", () => {
    expect(() => validatePathSegment("valid_segment", "test_segment")).not.toThrow();
    expect(() => validatePathSegment("run-123", "test_segment")).not.toThrow();
    expect(() => validatePathSegment("run_456", "test_segment")).not.toThrow();
  });

  it("rejects empty segment", () => {
    expect(() => validatePathSegment("", "test_segment")).toThrow(
      new ValidationError("test_segment cannot be empty"),
    );
  });

  it("rejects whitespace-only segment", () => {
    expect(() => validatePathSegment("   ", "test_segment")).toThrow(
      new ValidationError("test_segment cannot be empty"),
    );
  });

  it("rejects '.' segment", () => {
    expect(() => validatePathSegment(".", "test_segment")).toThrow(
      new ValidationError("test_segment cannot be '.' or '..'"),
    );
  });

  it("rejects '..' segment", () => {
    expect(() => validatePathSegment("..", "test_segment")).toThrow(
      new ValidationError("test_segment cannot be '.' or '..'"),
    );
  });

  it("rejects segment with forward slash", () => {
    expect(() => validatePathSegment("../evil", "test_segment")).toThrow(
      new ValidationError("test_segment cannot contain path separators"),
    );
  });

  it("rejects segment with backslash", () => {
    expect(() => validatePathSegment("evil\\path", "test_segment")).toThrow(
      new ValidationError("test_segment cannot contain path separators"),
    );
  });

  it("rejects segment with null byte", () => {
    expect(() => validatePathSegment("evil\x00byte", "test_segment")).toThrow(
      new ValidationError("test_segment cannot contain null bytes"),
    );
  });

  it("rejects glob '*'", () => {
    expect(() => validatePathSegment("*.webp", "test_segment")).toThrow(
      new ValidationError("test_segment cannot contain glob characters (* ? [ ])"),
    );
  });

  it("rejects glob '?'", () => {
    expect(() => validatePathSegment("file?.webp", "test_segment")).toThrow(
      new ValidationError("test_segment cannot contain glob characters (* ? [ ])"),
    );
  });

  it("rejects glob brackets", () => {
    expect(() => validatePathSegment("file[0-9].webp", "test_segment")).toThrow(
      new ValidationError("test_segment cannot contain glob characters (* ? [ ])"),
    );
  });
});

describe("validateSafePathContainment", () => {
  let tmpDir: string;
  let base: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-path-security-"));
    base = path.join(tmpDir, "base");
    fs.mkdirSync(base);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accepts a valid contained path", () => {
    const subdir = path.join(base, "subdir");
    fs.mkdirSync(subdir);
    expect(() => validateSafePathContainment(subdir, base, "test")).not.toThrow();
  });

  it("rejects a path that escapes the base", () => {
    const outside = path.join(tmpDir, "outside");
    fs.mkdirSync(outside);
    expect(() => validateSafePathContainment(outside, base, "test")).toThrow(ValidationError);
    expect(() => validateSafePathContainment(outside, base, "test")).toThrow(
      /test path .* is not contained within/,
    );
  });

  it("rejects a symlink that escapes the base", () => {
    const outside = path.join(tmpDir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    const symlink = path.join(base, "evil_link");
    fs.symlinkSync(outside, symlink);
    expect(() => validateSafePathContainment(symlink, base, "test")).toThrow(ValidationError);
    expect(() => validateSafePathContainment(symlink, base, "test")).toThrow(
      /test path .* is not contained within/,
    );
  });

  it("rejects relative path traversal (path does not exist)", () => {
    const target = path.join(base, "..", "..", "etc", "passwd");
    expect(() => validateSafePathContainment(target, base, "test")).toThrow(ValidationError);
    expect(() => validateSafePathContainment(target, base, "test")).toThrow(
      /test path .* is not contained within/,
    );
  });

  it("accepts a deeply nested valid path", () => {
    const nested = path.join(base, "level1", "level2", "level3");
    fs.mkdirSync(nested, { recursive: true });
    expect(() => validateSafePathContainment(nested, base, "test")).not.toThrow();
  });

  it("rejects non-existent path with traversal", () => {
    const target = path.join(base, "..", "etc", "passwd");
    expect(() => validateSafePathContainment(target, base, "test")).toThrow(ValidationError);
    expect(() => validateSafePathContainment(target, base, "test")).toThrow(
      /test path .* is not contained within/,
    );
  });
});

describe("path traversal attack vectors", () => {
  const maliciousSegments = [
    "..",
    "../..",
    "..\\/",
    "*",
    "?",
    "[test]",
    "dir/subdir",
    "\x00",
  ];

  it.each(maliciousSegments)("rejects malicious segment: %s", (segment) => {
    expect(() => validatePathSegment(segment, "test_segment")).toThrow(ValidationError);
  });
});
