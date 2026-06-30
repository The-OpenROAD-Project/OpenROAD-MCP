/**
 * PTY integration tests using real subprocesses (bash, cat, echo, sleep).
 * Port of tests/integration/test_pty_integration.py.
 *
 * These tests do NOT mock node-pty — they validate that PtyHandler correctly
 * drives real processes, which is the key behavioral parity check between the
 * TypeScript node-pty implementation and the Python pty implementation.
 *
 * Run: npm run test:integration
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { PtyHandler } from "../../src/interactive/pty_handler.js";
import { PTYError } from "../../src/interactive/models.js";
import { Settings } from "../../src/config/settings.js";

const SETTINGS = new Settings({ ENABLE_COMMAND_VALIDATION: false });

/** Collect all output from the handler's onData callback. */
function makeCollector(): { chunks: string[]; output: () => string } {
  const chunks: string[] = [];
  return { chunks, output: () => chunks.join("") };
}

/** Poll `check()` every `intervalMs` until it returns true or `deadlineMs` expires. */
async function waitUntil(check: () => boolean, deadlineMs: number, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  return check();
}

describe("PTY Integration", () => {
  let handler: PtyHandler;

  beforeEach(() => {
    handler = new PtyHandler(SETTINGS);
  });

  afterEach(async () => {
    await handler.cleanup();
  });

  it("basic echo command", async () => {
    const { chunks, output } = makeCollector();
    await handler.createSession(["echo", "hello world"], undefined, undefined, (d) => chunks.push(d));
    const code = await handler.waitForExit(5000);
    expect(code).toBe(0);
    expect(output()).toContain("hello world");
  });

  it("interactive input/output via cat", async () => {
    const { chunks, output } = makeCollector();
    await handler.createSession(["cat"], undefined, undefined, (d) => chunks.push(d));
    expect(handler.isProcessAlive()).toBe(true);

    handler.writeInput("test line\n");

    const found = await waitUntil(() => output().includes("test line"), 5000);
    expect(found).toBe(true);
    expect(output()).toContain("test line");

    await handler.terminateProcess(false);
    expect(handler.isProcessAlive()).toBe(false);
  });

  it("multi-line output from bash", async () => {
    const { chunks, output } = makeCollector();
    await handler.createSession(
      ["bash", "-c", "echo line1; echo line2; echo line3"],
      undefined,
      undefined,
      (d) => chunks.push(d),
    );
    const code = await handler.waitForExit(5000);
    expect(code).toBe(0);
    expect(output()).toContain("line1");
    expect(output()).toContain("line2");
    expect(output()).toContain("line3");
  });

  it("process lifecycle: spawn, verify alive, terminate, cleanup idempotent", async () => {
    await handler.createSession(["sleep", "10"]);
    expect(handler.isProcessAlive()).toBe(true);

    await handler.terminateProcess(false);
    expect(handler.isProcessAlive()).toBe(false);

    // cleanup is idempotent
    await expect(handler.cleanup()).resolves.not.toThrow();
    await expect(handler.cleanup()).resolves.not.toThrow();
  });

  it("error handling: invalid command throws PTYError or exits non-zero", async () => {
    // node-pty behaviour is platform-specific: on Linux spawn() throws synchronously
    // for a missing executable; on macOS the process entry is created and onExit
    // fires immediately with a non-zero code.
    try {
      await handler.createSession(["/nonexistent/command_xyz"]);
      // If createSession resolved, the process should have exited with an error code.
      const code = await handler.waitForExit(2000);
      expect(code).not.toBe(0);
    } catch (e) {
      expect(e).toBeInstanceOf(PTYError);
    }
  });

  it("concurrent read/write via cat", async () => {
    const { chunks, output } = makeCollector();
    await handler.createSession(["cat"], undefined, undefined, (d) => chunks.push(d));

    const lines = ["concurrent line 0", "concurrent line 1", "concurrent line 2"];

    const writer = (async () => {
      for (const line of lines) {
        handler.writeInput(`${line}\n`);
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      await handler.terminateProcess(false);
    })();

    const reader = (async () => {
      const found = await waitUntil(
        () => lines.every((l) => output().includes(l)),
        8000,
      );
      return found;
    })();

    const [, allFound] = await Promise.all([writer, reader]);
    expect(allFound).toBe(true);
    for (const line of lines) {
      expect(output()).toContain(line);
    }
  });

  it("environment variable and working directory", async () => {
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `pty_test_${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, "");
    const filename = path.basename(tmpFile);

    try {
      const { chunks, output } = makeCollector();
      await handler.createSession(
        ["bash", "-c", `echo $TEST_VAR; ls ${filename}`],
        { TEST_VAR: "env_test_value" },
        tmpDir,
        (d) => chunks.push(d),
      );
      const code = await handler.waitForExit(5000);
      expect(code).toBe(0);
      expect(output()).toContain("env_test_value");
      expect(output()).toContain(filename);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("large output handling: 100-line bash loop", async () => {
    const { chunks, output } = makeCollector();
    await handler.createSession(
      ["bash", "-c", 'for i in $(seq 1 100); do echo "This is line $i with some extra text"; done'],
      undefined,
      undefined,
      (d) => chunks.push(d),
    );
    const code = await handler.waitForExit(10000);
    expect(code).toBe(0);
    expect(output().length).toBeGreaterThan(1000);
    expect(output()).toContain("line 1");
    expect(output()).toContain("line 100");
  });

  it("timeout behavior: waitForExit returns null before process exits", async () => {
    await handler.createSession(["sleep", "10"]);

    // 100ms timeout — process won't exit in time
    const result = await handler.waitForExit(100);
    expect(result).toBeNull();
    expect(handler.isProcessAlive()).toBe(true);

    // Force terminate
    await handler.terminateProcess(true);
    await waitUntil(() => !handler.isProcessAlive(), 3000);
    expect(handler.isProcessAlive()).toBe(false);
  });

  it("sequential sessions: two independent sessions", async () => {
    // First session
    const handler1 = new PtyHandler(SETTINGS);
    const collector1 = makeCollector();
    await handler1.createSession(
      ["echo", "first_session_output"],
      undefined,
      undefined,
      (d) => collector1.chunks.push(d),
    );
    const code1 = await handler1.waitForExit(5000);
    await handler1.cleanup();

    expect(code1).toBe(0);
    expect(collector1.output()).toContain("first_session_output");

    // Second session (handler from beforeEach)
    const collector2 = makeCollector();
    await handler.createSession(
      ["echo", "second_session_output"],
      undefined,
      undefined,
      (d) => collector2.chunks.push(d),
    );
    const code2 = await handler.waitForExit(5000);

    expect(code2).toBe(0);
    expect(collector2.output()).toContain("second_session_output");
    // outputs are independent
    expect(collector1.output()).not.toContain("second_session_output");
    expect(collector2.output()).not.toContain("first_session_output");
  });
});
