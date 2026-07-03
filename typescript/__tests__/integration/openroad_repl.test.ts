import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { OpenROADManager } from "../../src/core/manager.js";

// Real-OpenROAD REPL parity gate (doc Week-1 PTY gate + Risk 1).
//
// The other integration tests drive generic PTYs (bash/cat). This suite drives
// the actual OpenROAD Tcl REPL through the full session stack
// (OpenROADManager -> InteractiveSession -> node-pty), validating the four
// known node-pty-vs-Python behavioral hazards:
//   1. completion detection (100ms silence window), stable across repeats
//   2. prompt stripping + ANSI cleanup (no "openroad>" / no escape codes)
//   3. large-output buffering
//   4. is_alive === false after the process exits
//
// It only runs where the `openroad` binary is present (the ORFS Docker image /
// a local OpenROAD install). Elsewhere it is skipped, so unit CI stays green
// without OpenROAD.

const ESC = "\x1b";

function hasOpenROAD(): boolean {
  try {
    const r = spawnSync("openroad", ["-version"], { timeout: 15000 });
    return r.status === 0 || (r.stdout != null && r.stdout.length > 0);
  } catch {
    return false;
  }
}

async function waitUntilAsync(
  check: () => Promise<boolean>,
  deadlineMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  return check();
}

// Drain OpenROAD's (delayed) startup banner so subsequent reads line up with
// the command that produced them. Neither implementation waits for REPL
// readiness on spawn (Python's _wait_for_startup_ready is commented out), so
// the first reads after createSession return the echo before the banner and
// evaluated output arrive. Assertions below use eval-only markers (e.g. "42"),
// never the echoed command text, so they can't pass on the echo alone.
async function warmUp(manager: OpenROADManager, id: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const r = await manager.executeCommand(id, "puts [expr 21*2]");
    if (r.output.includes("42")) return;
  }
  throw new Error("OpenROAD REPL never became ready");
}

describe.skipIf(!hasOpenROAD())("OpenROAD REPL integration", () => {
  let manager: OpenROADManager;
  let sessionId: string;

  beforeAll(async () => {
    manager = new OpenROADManager();
    sessionId = await manager.createSession({});
    await warmUp(manager, sessionId);
  }, 60000);

  afterAll(async () => {
    await manager.cleanupAll();
  });

  it("completion detection captures evaluated string output", async () => {
    const result = await manager.executeCommand(sessionId, "puts [string repeat AB 5]");
    expect(result.error).toBeNull();
    // "ABABABABAB" appears only in the evaluated output, not the echoed command.
    expect(result.output).toContain("ABABABABAB");
    // Prompt stripping + ANSI cleanup: no REPL prompt artifact, no escape codes.
    expect(result.output).not.toContain("openroad>");
    expect(result.output).not.toContain(ESC);
  }, 30000);

  it("evaluates Tcl expressions", async () => {
    const result = await manager.executeCommand(sessionId, "puts [expr {123 + 456}]");
    expect(result.error).toBeNull();
    // "579" is only in the result; the echo contains "123 + 456".
    expect(result.output).toContain("579");
  }, 30000);

  it("completion detection is stable across repeated commands", async () => {
    // Each command must return its OWN evaluated marker on its OWN read — this
    // is the alignment/stability guarantee. Markers use string-repeat so the
    // evaluated value (e.g. "YYYYYYY") is never a substring of the echoed
    // command ("puts [string repeat Y 7]").
    for (let i = 0; i < 5; i++) {
      const n = 5 + i;
      const marker = "Y".repeat(n);
      const result = await manager.executeCommand(sessionId, `puts [string repeat Y ${n}]`);
      expect(result.error).toBeNull();
      expect(result.output).toContain(marker);
    }
  }, 60000);

  it("buffers large output without truncation", async () => {
    const result = await manager.executeCommand(
      sessionId,
      "for {set i 0} {$i < 2000} {incr i} { puts [expr {$i + 100000}] }",
    );
    expect(result.error).toBeNull();
    // First and last evaluated values; neither appears in the one-line echo.
    expect(result.output).toContain("100000");
    expect(result.output).toContain("101999");
    expect(result.output.length).toBeGreaterThan(10000);
  }, 45000);

  it("reports is_alive === false after the process exits", async () => {
    const exitId = await manager.createSession({});
    expect((await manager.getSessionInfo(exitId)).isAlive).toBe(true);

    // "exit" ends the OpenROAD process; readOutput may resolve with buffered
    // output or reject once the process is gone — both are acceptable here.
    try {
      await manager.executeCommand(exitId, "exit");
    } catch {
      /* process exited mid-read */
    }

    // getInfo() recomputes liveness via checkAlive(); the session stays mapped
    // until the next cleanup pass, so this does not throw.
    const dead = await waitUntilAsync(
      async () => !(await manager.getSessionInfo(exitId)).isAlive,
      10000,
    );
    expect(dead).toBe(true);
    expect((await manager.getSessionInfo(exitId)).isAlive).toBe(false);
  }, 30000);
});
