import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Mock } from "vitest";
import { OpenROADManager } from "../../src/core/manager.js";
import { SessionError, SessionNotFoundError } from "../../src/interactive/models.js";
import { InteractiveSession } from "../../src/interactive/session.js";
import { SessionState } from "../../src/core/models.js";
import type { SessionDetailedMetrics } from "../../src/core/models.js";

// Stub the InteractiveSession constructor so the manager never spawns a PTY.
vi.mock("../../src/interactive/session.js", () => {
  return {
    InteractiveSession: vi.fn(),
  };
});

interface MockSession {
  sessionId: string;
  lastActivity: Date;
  isAlive: Mock;
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

function makeMockSession(sessionId: string, alive = true): MockSession {
  const metrics: SessionDetailedMetrics = {
    session_id: sessionId,
    state: SessionState.ACTIVE,
    is_alive: alive,
    created_at: new Date().toISOString(),
    last_activity: new Date().toISOString(),
    uptime_seconds: 1,
    idle_seconds: 0,
    commands: { total_executed: 3, current_count: 3, history_length: 3 },
    performance: { total_cpu_time: 0.5, peak_memory_mb: 10, current_memory_mb: 8 },
    buffer: { current_size: 0, max_size: 1024, utilization_percent: 0 },
    timeout: { configured_seconds: null, is_timed_out: false },
  };

  return {
    sessionId,
    lastActivity: new Date(),
    isAlive: vi.fn().mockReturnValue(alive),
    start: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn().mockResolvedValue(undefined),
    readOutput: vi.fn().mockResolvedValue({
      output: "ok",
      sessionId,
      timestamp: new Date().toISOString(),
      executionTime: 0.01,
      commandCount: 1,
      bufferSize: 0,
      error: null,
    }),
    getInfo: vi.fn().mockResolvedValue({
      sessionId,
      createdAt: new Date().toISOString(),
      isAlive: alive,
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

const MockedSession = vi.mocked(InteractiveSession);

describe("OpenROADManager", () => {
  let manager: OpenROADManager;
  let created: MockSession[];

  beforeEach(() => {
    vi.clearAllMocks();
    created = [];
    // Each `new InteractiveSession(id)` yields a fresh mock the test can inspect.
    // A regular function (not an arrow) is required so it is constructable.
    MockedSession.mockImplementation(function (this: unknown, sessionId: string) {
      const mock = makeMockSession(sessionId);
      created.push(mock);
      return mock as unknown as InteractiveSession;
    } as unknown as (sessionId: string) => InteractiveSession);
    manager = new OpenROADManager(50);
  });

  describe("createSession", () => {
    it("generates an 8-char id, starts the session, and stores it", async () => {
      const id = await manager.createSession();
      expect(id).toHaveLength(8);
      expect(created).toHaveLength(1);
      expect(created[0]!.start).toHaveBeenCalledOnce();
      expect(manager.getSessionCount()).toBe(1);
    });

    it("honours an explicit session id and forwards start args", async () => {
      const id = await manager.createSession({
        sessionId: "abc",
        command: ["openroad", "-no_init"],
        env: { FOO: "bar" },
        cwd: "/tmp",
      });
      expect(id).toBe("abc");
      expect(created[0]!.start).toHaveBeenCalledWith(["openroad", "-no_init"], { FOO: "bar" }, "/tmp");
    });

    it("throws SessionError on a duplicate id", async () => {
      await manager.createSession({ sessionId: "dup" });
      await expect(manager.createSession({ sessionId: "dup" })).rejects.toBeInstanceOf(SessionError);
    });

    it("throws SessionError when at max capacity", async () => {
      const limited = new OpenROADManager(1);
      await limited.createSession({ sessionId: "s1" });
      await expect(limited.createSession({ sessionId: "s2" })).rejects.toThrow(/Maximum session limit/);
    });

    it("falls back to the default buffer size when bufferSize is 0", async () => {
      await manager.createSession({ sessionId: "zero", bufferSize: 0 });
      // InteractiveSession is constructed with (sessionId, bufferSize); a 0 must
      // not reach it - it would yield a zero-capacity buffer that drops output.
      expect(MockedSession).toHaveBeenCalledWith("zero", expect.any(Number));
      const bufArg = MockedSession.mock.calls[0]![1] as number;
      expect(bufArg).toBeGreaterThan(0);
    });

    it("removes the placeholder when start() fails", async () => {
      MockedSession.mockImplementationOnce(function (this: unknown, sessionId: string) {
        const mock = makeMockSession(sessionId);
        mock.start.mockRejectedValueOnce(new Error("spawn failed"));
        created.push(mock);
        return mock as unknown as InteractiveSession;
      } as unknown as (sessionId: string) => InteractiveSession);
      await expect(manager.createSession({ sessionId: "bad" })).rejects.toBeInstanceOf(SessionError);
      expect(manager.getSessionCount()).toBe(0);
    });
  });

  describe("executeCommand", () => {
    it("delegates to sendCommand then readOutput", async () => {
      await manager.createSession({ sessionId: "s1" });
      const result = await manager.executeCommand("s1", "report_wns");
      expect(created[0]!.sendCommand).toHaveBeenCalledWith("report_wns");
      expect(created[0]!.readOutput).toHaveBeenCalledOnce();
      expect(result.output).toBe("ok");
    });

    it("throws SessionNotFoundError for an unknown session", async () => {
      await expect(manager.executeCommand("nope", "report_wns")).rejects.toBeInstanceOf(
        SessionNotFoundError,
      );
    });

    it("falls back to the default timeout when timeoutMs is 0", async () => {
      await manager.createSession({ sessionId: "s1" });
      await manager.executeCommand("s1", "report_wns", 0);
      // 0 must not be forwarded as an instant timeout; readOutput gets the default.
      const timeoutArg = created[0]!.readOutput.mock.calls[0]![0] as number;
      expect(timeoutArg).toBeGreaterThan(0);
    });
  });

  describe("listSessions", () => {
    it("returns info for each active session", async () => {
      await manager.createSession({ sessionId: "s1" });
      await manager.createSession({ sessionId: "s2" });
      const infos = await manager.listSessions();
      expect(infos).toHaveLength(2);
      expect(infos.map((i) => i.sessionId).sort()).toEqual(["s1", "s2"]);
    });
  });

  describe("terminateSession", () => {
    it("terminates, cleans up, and removes the session", async () => {
      await manager.createSession({ sessionId: "s1" });
      await manager.terminateSession("s1", true);
      expect(created[0]!.terminate).toHaveBeenCalledWith(true);
      expect(created[0]!.cleanup).toHaveBeenCalledOnce();
      expect(manager.getSessionCount()).toBe(0);
    });
  });

  describe("terminateAllSessions", () => {
    it("terminates every session in parallel", async () => {
      await manager.createSession({ sessionId: "s1" });
      await manager.createSession({ sessionId: "s2" });
      const count = await manager.terminateAllSessions();
      expect(count).toBe(2);
      expect(manager.getSessionCount()).toBe(0);
    });
  });

  describe("inspectSession & getSessionHistory", () => {
    it("inspectSession delegates to getDetailedMetrics", async () => {
      await manager.createSession({ sessionId: "s1" });
      const metrics = await manager.inspectSession("s1");
      expect(created[0]!.getDetailedMetrics).toHaveBeenCalledOnce();
      expect(metrics.session_id).toBe("s1");
    });

    it("getSessionHistory forwards limit and search", async () => {
      await manager.createSession({ sessionId: "s1" });
      await manager.getSessionHistory("s1", 5, "report");
      expect(created[0]!.getCommandHistory).toHaveBeenCalledWith(5, "report");
    });
  });

  describe("sessionMetrics", () => {
    it("aggregates per-session metrics", async () => {
      await manager.createSession({ sessionId: "s1" });
      await manager.createSession({ sessionId: "s2" });
      const metrics = await manager.sessionMetrics();
      expect(metrics.manager.total_sessions).toBe(2);
      expect(metrics.manager.active_sessions).toBe(2);
      expect(metrics.aggregate.total_commands).toBe(6); // 3 per mock session
      expect(metrics.sessions).toHaveLength(2);
    });
  });

  describe("cleanupIdleSessions", () => {
    it("terminates idle sessions and leaves active ones", async () => {
      await manager.createSession({ sessionId: "idle" });
      await manager.createSession({ sessionId: "busy" });
      created[0]!.isIdleTimeout.mockReturnValue(true); // "idle"
      created[1]!.isIdleTimeout.mockReturnValue(false); // "busy"

      const cleaned = await manager.cleanupIdleSessions(300, true);
      expect(cleaned).toBe(1);
      expect(manager.getSessionCount()).toBe(1);
    });
  });

  describe("_getSession behaviour via public methods", () => {
    it("getSessionInfo throws SessionNotFoundError for an unknown id", async () => {
      await expect(manager.getSessionInfo("ghost")).rejects.toBeInstanceOf(SessionNotFoundError);
    });
  });
});
