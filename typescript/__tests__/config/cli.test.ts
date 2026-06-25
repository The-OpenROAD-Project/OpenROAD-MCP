import { describe, it, expect, vi, afterEach } from "vitest";
import { parseCliArgs } from "../../src/config/cli.js";
import { ValidationError } from "../../src/exceptions.js";

describe("parseCliArgs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns stdio defaults with no args", () => {
    expect(parseCliArgs([])).toEqual({
      transport: { mode: "stdio", host: "localhost", port: 8000 },
      verbose: false,
      logLevel: "INFO",
    });
  });

  it("parses http transport with custom host and port", () => {
    expect(parseCliArgs(["-t", "http", "--host", "0.0.0.0", "--port", "8080"])).toEqual({
      transport: { mode: "http", host: "0.0.0.0", port: 8080 },
      verbose: false,
      logLevel: "INFO",
    });
  });

  it("parses verbose and log level", () => {
    const config = parseCliArgs(["--verbose", "--log-level", "DEBUG"]);
    expect(config.verbose).toBe(true);
    expect(config.logLevel).toBe("DEBUG");
  });

  it("rejects --host without http transport", () => {
    expect(() => parseCliArgs(["--host", "0.0.0.0"])).toThrow(ValidationError);
    expect(() => parseCliArgs(["--host", "0.0.0.0"])).toThrow(
      "--host and --port options are only valid with --transport http",
    );
  });

  it("rejects --port without http transport", () => {
    expect(() => parseCliArgs(["--port", "9000"])).toThrow(
      "--host and --port options are only valid with --transport http",
    );
  });

  it("rejects an invalid transport choice", () => {
    // commander prints the error to stderr before throwing; silence it.
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(() => parseCliArgs(["--transport", "bogus"])).toThrow(ValidationError);
  });

  it("rejects an invalid log level choice", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(() => parseCliArgs(["--log-level", "TRACE"])).toThrow(ValidationError);
  });

  it("rejects a non-numeric port", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(() => parseCliArgs(["-t", "http", "--port", "abc"])).toThrow(ValidationError);
  });
});
