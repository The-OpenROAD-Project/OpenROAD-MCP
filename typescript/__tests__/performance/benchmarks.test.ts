import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Mock } from "vitest";
import { OpenROADManager } from "../../src/core/manager.js";
import { InteractiveSession } from "../../src/interactive/session.js";
import { CircularBuffer } from "../../src/interactive/buffer.js";
import { SessionState } from "../../src/core/models.js";
import type { SessionDetailedMetrics } from "../../src/core/models.js";

vi.mock("../../src/interactive/session.js", () => ({ InteractiveSession: vi.fn() }));

interface MockSession {
  sessionId: string;
  lastActivity: Date;
  checkAlive: Mock;
  start: Mock;
  sendCommand: Mock;
  readOutput: Mock;
  getInfo: Mock;
  getDetailedMetrics: Mock;
  getCommandHistory: Mock;
  isIdleTimeout: Mock;
  setSessionTimeout: Mock;
  terminate: Mock;
  cleanup: Mock;
}

function makeMockSession(sessionId: string): MockSession {
  const metrics: SessionDetailedMetrics = {
    sessionId,
    state: SessionState.ACTIVE,
    isAlive: true,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    uptimeSeconds: 1,
    idleSeconds: 0,
    commands: { totalExecuted: 0, currentCount: 0, historyLength: 0 },
    performance: { totalCpuTime: 0, peakMemoryMb: 1, currentMemoryMb: 1 },
    buffer: { currentSize: 0, maxSize: 1024, utilizationPercent: 0 },
    timeout: { configuredSeconds: null, isTimedOut: false },
  };
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
    getDetailedMetrics: vi.fn().mockResolvedValue(metrics),
    getCommandHistory: vi.fn().mockReturnValue([]),
    isIdleTimeout: vi.fn().mockReturnValue(false),
    setSessionTimeout: vi.fn(),
    terminate: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[idx]!;
}

const MockedSession = vi.mocked(InteractiveSession);

describe("Performance Benchmarks", () => {
  let manager: OpenROADManager;
  let created: MockSession[];

  beforeEach(() => {
    vi.clearAllMocks();
    created = [];
    MockedSession.mockImplementation(function (this: unknown, sessionId: string) {
      const mock = makeMockSession(sessionId);
      created.push(mock);
      return mock as unknown as InteractiveSession;
    } as unknown as (sessionId: string) => InteractiveSession);
    manager = new OpenROADManager(100);
  });

  it("session creation latency: avg < 25ms, max < 50ms", async () => {
    const N = 10;
    const latencies: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      await manager.createSession({ sessionId: `lat-${i}` });
      latencies.push(performance.now() - t0);
    }
    const avg = latencies.reduce((a, b) => a + b, 0) / N;
    const max = Math.max(...latencies);
    console.log(`  session creation: avg=${avg.toFixed(2)}ms max=${max.toFixed(2)}ms`);
    expect(avg).toBeLessThan(25);
    expect(max).toBeLessThan(50);
  });

  it("output streaming throughput: > 10 MB/s, < 5s for 1MB", async () => {
    const BUF_SIZE = 10 * 1024 * 1024;
    const CHUNK = "x".repeat(1024);
    const CHUNKS = 1000;
    const buf = new CircularBuffer(BUF_SIZE);

    const t0 = performance.now();
    for (let i = 0; i < CHUNKS; i++) {
      await buf.append(CHUNK);
    }
    await buf.drainAll();
    const durationS = (performance.now() - t0) / 1000;
    const throughputMBs = (CHUNKS * 1024) / (1024 * 1024) / durationS;
    console.log(`  streaming: ${throughputMBs.toFixed(1)} MB/s in ${durationS.toFixed(3)}s`);
    expect(throughputMBs).toBeGreaterThan(10);
    expect(durationS).toBeLessThan(5);
  });

  it("concurrent session scalability: 50 sessions, p95 < 100ms, p99 < 200ms", async () => {
    const N = 50;
    const ids = await Promise.all(
      Array.from({ length: N }, (_, i) => manager.createSession({ sessionId: `con-${i}` })),
    );
    expect(new Set(ids).size).toBe(N);

    const latencies: number[] = [];
    await Promise.all(
      ids.map(async (id) => {
        const t0 = performance.now();
        await manager.executeCommand(id, "version");
        latencies.push(performance.now() - t0);
      }),
    );
    latencies.sort((a, b) => a - b);
    const p95 = percentile(latencies, 0.95);
    const p99 = percentile(latencies, 0.99);
    console.log(`  concurrent: p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms`);
    expect(p95).toBeLessThan(100);
    expect(p99).toBeLessThan(200);
  });

  it("memory usage profiling: heap increase < 5x expected for 10 sessions x 1MB", async () => {
    const N = 10;
    const BUF_SIZE = 1024 * 1024;
    const FILL = BUF_SIZE * 0.1;
    const CHUNK = "m".repeat(1024);

    if (typeof global.gc === "function") global.gc();
    const before = process.memoryUsage().heapUsed / (1024 * 1024);

    const bufs: CircularBuffer[] = [];
    for (let i = 0; i < N; i++) {
      const buf = new CircularBuffer(BUF_SIZE);
      const writes = Math.floor(FILL / 1024);
      for (let j = 0; j < writes; j++) await buf.append(CHUNK);
      bufs.push(buf);
    }

    if (typeof global.gc === "function") global.gc();
    const after = process.memoryUsage().heapUsed / (1024 * 1024);
    const increase = after - before;
    const expectedMb = (N * FILL) / (1024 * 1024);
    console.log(`  memory: increased ${increase.toFixed(1)}MB, expected ${expectedMb.toFixed(1)}MB`);
    expect(increase).toBeLessThan(expectedMb * 2);

    for (const buf of bufs) await buf.drainAll();
  });

  it("buffer overflow performance: > 1000 ops/sec, final size <= capacity", async () => {
    const BUF_SIZE = 1024 * 1024;
    const CHUNK = "o".repeat(1024);
    const WRITES = 2048;

    const buf = new CircularBuffer(BUF_SIZE);
    const t0 = performance.now();
    for (let i = 0; i < WRITES; i++) await buf.append(CHUNK);
    const durationS = (performance.now() - t0) / 1000;
    const opsPerSec = WRITES / durationS;

    const drained = await buf.drainAll();
    const finalSize = drained.reduce((s, c) => s + c.length, 0);

    console.log(`  buffer overflow: ${opsPerSec.toFixed(0)} ops/s, final=${(finalSize / 1024).toFixed(1)}KB`);
    expect(opsPerSec).toBeGreaterThan(1000);
    expect(durationS).toBeLessThan(5);
    expect(finalSize).toBeLessThanOrEqual(BUF_SIZE);
  });

  it("command execution latency: avg < 10ms, p95 < 20ms, max < 50ms", async () => {
    const N = 50;
    const id = await manager.createSession({ sessionId: "cmd-lat" });
    const latencies: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      await manager.executeCommand(id, `puts ${i}`);
      latencies.push(performance.now() - t0);
    }
    latencies.sort((a, b) => a - b);
    const avg = latencies.reduce((a, b) => a + b, 0) / N;
    const p95 = percentile(latencies, 0.95);
    const max = latencies[latencies.length - 1]!;
    console.log(`  cmd latency: avg=${avg.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms`);
    expect(avg).toBeLessThan(10);
    expect(p95).toBeLessThan(20);
    expect(max).toBeLessThan(50);
  });
});

describe("Stress Tests", () => {
  let manager: OpenROADManager;
  let created: MockSession[];

  beforeEach(() => {
    vi.clearAllMocks();
    created = [];
    MockedSession.mockImplementation(function (this: unknown, sessionId: string) {
      const mock = makeMockSession(sessionId);
      created.push(mock);
      return mock as unknown as InteractiveSession;
    } as unknown as (sessionId: string) => InteractiveSession);
    manager = new OpenROADManager(200);
  });

  it("long running session stability: 1000 commands in batches of 50", async () => {
    const id = await manager.createSession({ sessionId: "stability" });
    const TOTAL = 1000;
    const BATCH = 50;

    for (let i = 0; i < TOTAL / BATCH; i++) {
      await Promise.all(
        Array.from({ length: BATCH }, (_, j) =>
          manager.executeCommand(id, `puts ${i * BATCH + j}`),
        ),
      );
    }

    const session = created[0]!;
    expect(session.readOutput.mock.calls.length).toBe(TOTAL);
    expect(session.checkAlive()).toBe(true);
  });

  it("resource exhaustion: session limit is enforced once maxSessions is reached, cleanupAll < 10s", async () => {
    const LIMIT = 20;
    const exhaustedManager = new OpenROADManager(LIMIT);
    const MAX = 100; // attempts well past LIMIT so the cap is actually exercised
    let succeeded = 0;

    for (let i = 0; i < MAX; i++) {
      try {
        await exhaustedManager.createSession({ sessionId: `res-${i}` });
        succeeded++;
      } catch {
        break;
      }
    }
    expect(succeeded).toBe(LIMIT);
    await expect(
      exhaustedManager.createSession({ sessionId: "res-overflow" }),
    ).rejects.toThrow(/maximum session limit reached/i);

    const t0 = performance.now();
    await exhaustedManager.cleanupAll();
    const cleanupMs = performance.now() - t0;
    console.log(`  cleanup of ${succeeded} sessions: ${cleanupMs.toFixed(0)}ms`);
    expect(cleanupMs).toBeLessThan(10000);
  });

  it("large output through 128KB buffer: final size <= capacity, duration < 2s", async () => {
    const BUF_SIZE = 128 * 1024;
    const CHUNK_SIZE = 16 * 1024;
    const WRITES = 320;
    const CHUNK = "L".repeat(CHUNK_SIZE);

    const buf = new CircularBuffer(BUF_SIZE);
    const t0 = performance.now();
    for (let i = 0; i < WRITES; i++) await buf.append(CHUNK);
    const durationS = (performance.now() - t0) / 1000;

    const drained = await buf.drainAll();
    const finalSize = drained.reduce((s, c) => s + c.length, 0);

    console.log(`  large output: final=${(finalSize / 1024).toFixed(1)}KB duration=${durationS.toFixed(3)}s`);
    expect(finalSize).toBeLessThanOrEqual(BUF_SIZE);
    expect(durationS).toBeLessThan(2);
  });
});
