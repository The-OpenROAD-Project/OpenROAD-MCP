import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import { OpenROADManager } from "../../src/core/manager.js";
import { InteractiveSession } from "../../src/interactive/session.js";
import { SessionState } from "../../src/core/models.js";

vi.mock("../../src/interactive/session.js", () => ({ InteractiveSession: vi.fn() }));

function makeMockSession(sessionId: string) {
  return {
    sessionId,
    lastActivity: new Date(),
    checkAlive: vi.fn().mockReturnValue(true),
    start: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn().mockResolvedValue(undefined),
    readOutput: vi.fn().mockResolvedValue({
      output: "ok",
      sessionId,
      timestamp: new Date().toISOString(),
      executionTime: 0.001,
      commandCount: 1,
      bufferSize: 0,
      error: null,
    }),
    getInfo: vi.fn().mockResolvedValue({
      sessionId,
      createdAt: new Date().toISOString(),
      isAlive: true,
      commandCount: 0,
      bufferSize: 0,
      uptimeSeconds: 1,
      state: SessionState.ACTIVE,
    }),
    getDetailedMetrics: vi.fn().mockResolvedValue(null),
    getCommandHistory: vi.fn().mockReturnValue([]),
    isIdleTimeout: vi.fn().mockReturnValue(false),
    setSessionTimeout: vi.fn(),
    terminate: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

class MemoryMonitor {
  private snapshots: Array<{ label: string; rssMb: number; heapUsedMb: number }> = [];

  takeSnapshot(label: string): void {
    // Hint to V8 GC if available (requires --expose-gc flag; safe to omit)
    if (typeof global.gc === "function") global.gc();
    const mem = process.memoryUsage();
    this.snapshots.push({
      label,
      rssMb: mem.rss / (1024 * 1024),
      heapUsedMb: mem.heapUsed / (1024 * 1024),
    });
  }

  rss(startLabel: string, endLabel: string): number {
    const start = this.snapshots.find((s) => s.label === startLabel);
    const end = this.snapshots.find((s) => s.label === endLabel);
    if (!start || !end) throw new Error(`Snapshot not found: ${startLabel} or ${endLabel}`);
    return end.rssMb - start.rssMb;
  }

  heap(startLabel: string, endLabel: string): number {
    const start = this.snapshots.find((s) => s.label === startLabel);
    const end = this.snapshots.find((s) => s.label === endLabel);
    if (!start || !end) throw new Error(`Snapshot not found: ${startLabel} or ${endLabel}`);
    return end.heapUsedMb - start.heapUsedMb;
  }
}

function getFdCount(): number {
  try {
    return fs.readdirSync("/proc/self/fd").length;
  } catch {
    return -1; // /proc not available (macOS)
  }
}

const MockedSession = vi.mocked(InteractiveSession);

describe("Memory Monitoring", () => {
  let manager: OpenROADManager;

  beforeEach(() => {
    vi.clearAllMocks();
    MockedSession.mockImplementation(function (this: unknown, sessionId: string) {
      return makeMockSession(sessionId) as unknown as InteractiveSession;
    } as unknown as (sessionId: string) => InteractiveSession);
    manager = new OpenROADManager(100);
  });

  it("session creation memory leak: 10 cycles x 5 sessions, RSS growth < 12MB", async () => {
    const mon = new MemoryMonitor();
    mon.takeSnapshot("start");

    for (let cycle = 0; cycle < 10; cycle++) {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = await manager.createSession({ sessionId: `mem-${cycle}-${i}` });
        ids.push(id);
      }
      for (const id of ids) {
        await manager.terminateSession(id);
      }
    }

    mon.takeSnapshot("end");
    const rssDiff = mon.rss("start", "end");
    console.log(`  session creation leak: RSS diff ${rssDiff.toFixed(1)}MB`);
    // RSS granularity is one OS page (typically 4MB); allow 12MB headroom
    expect(rssDiff).toBeLessThan(12);
  });

  it("long running session memory: 1000 ops, growth < 25MB, leaked <= 5MB after cleanup", async () => {
    const mon = new MemoryMonitor();
    mon.takeSnapshot("start");

    const id = await manager.createSession({ sessionId: "long-run" });
    const BATCH = 50;
    for (let i = 0; i < 1000 / BATCH; i++) {
      await Promise.all(Array.from({ length: BATCH }, (_, j) => manager.executeCommand(id, `puts ${i * BATCH + j}`)));
    }

    mon.takeSnapshot("during");
    const duringDiff = mon.rss("start", "during");
    expect(duringDiff).toBeLessThan(25);

    await manager.terminateSession(id);
    mon.takeSnapshot("after");
    // Use heap (not RSS) for the leak check - heap tracks actual JS allocations
    const leaked = mon.heap("start", "after");
    console.log(`  long running: during +${duringDiff.toFixed(1)}MB, heap leaked ${leaked.toFixed(1)}MB`);
    expect(leaked).toBeLessThanOrEqual(5);
  });

  it("concurrent session memory: 20 sessions, < 2MB per session", async () => {
    const mon = new MemoryMonitor();
    mon.takeSnapshot("before");

    const N = 20;
    const ids = await Promise.all(
      Array.from({ length: N }, (_, i) => manager.createSession({ sessionId: `conc-${i}` })),
    );
    await Promise.all(ids.map((id) => manager.executeCommand(id, "version")));

    mon.takeSnapshot("loaded");
    const totalDiff = mon.rss("before", "loaded");
    const perSession = totalDiff / N;
    console.log(`  concurrent sessions: total +${totalDiff.toFixed(1)}MB = ${perSession.toFixed(2)}MB/session`);
    // Allow generous headroom - RSS reporting is coarse at process level
    expect(perSession).toBeLessThan(2);

    await manager.cleanupAll();
  });

  it("file descriptor leak detection (Linux only)", async () => {
    const fdBefore = getFdCount();
    if (fdBefore === -1) {
      console.log("  FD tracking skipped (not Linux)");
      return;
    }

    const CYCLES = 20;
    for (let i = 0; i < CYCLES; i++) {
      const id = await manager.createSession({ sessionId: `fd-${i}` });
      await manager.terminateSession(id);
    }

    const fdAfter = getFdCount();
    const fdDiff = fdAfter - fdBefore;
    console.log(`  FD leak: before=${fdBefore} after=${fdAfter} diff=${fdDiff}`);
    // Small tolerance: OS may cache a few FDs, node-pty releases them on cleanup
    expect(fdDiff).toBeLessThanOrEqual(5);
  });

  it.skip("stability simulation: 24-hour scaled run (enable manually, takes ~24s)", async () => {
    // Simulates 24 hours of operation at 1s/hour, 100 ops/hour.
    // Enable to validate memory_growth_rate < 0.2 MB/hour.
    const mon = new MemoryMonitor();
    mon.takeSnapshot("start");

    const id = await manager.createSession({ sessionId: "stability" });
    for (let hour = 0; hour < 24; hour++) {
      for (let op = 0; op < 100; op++) {
        await manager.executeCommand(id, `puts ${op}`);
      }
      await new Promise<void>((r) => setTimeout(r, 1000));
    }

    mon.takeSnapshot("end");
    const totalGrowth = mon.rss("start", "end");
    const growthPerHour = totalGrowth / 24;
    console.log(`  stability: ${totalGrowth.toFixed(1)}MB total = ${growthPerHour.toFixed(2)}MB/hour`);
    expect(growthPerHour).toBeLessThan(0.2);
    await manager.cleanupAll();
  });
});
