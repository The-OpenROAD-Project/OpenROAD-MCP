import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Mock } from "vitest";
import { QueryShellTool, ExecShellTool, ListSessionsTool, CreateSessionTool, TerminateSessionTool, InspectSessionTool, SessionHistoryTool, SessionMetricsTool, InteractiveShellTool } from "../../src/tools/interactive.js";
import type { OpenROADManager } from "../../src/core/manager.js";
import { SessionNotFoundError, SessionTerminatedError, SessionError } from "../../src/interactive/models.js";
import { SessionState } from "../../src/core/models.js";
import type { InteractiveExecResult, InteractiveSessionInfo, SessionDetailedMetrics, ManagerMetrics } from "../../src/core/models.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const NOW = "2024-01-01T00:00:00.000Z";

function makeExecResult(overrides: Partial<InteractiveExecResult> = {}): InteractiveExecResult {
  return {
    output: "test output",
    sessionId: "session-1",
    timestamp: NOW,
    executionTime: 0.1,
    commandCount: 1,
    bufferSize: 0,
    error: null,
    ...overrides,
  };
}

function makeSessionInfo(overrides: Partial<InteractiveSessionInfo> = {}): InteractiveSessionInfo {
  return {
    sessionId: "session-1",
    createdAt: NOW,
    isAlive: true,
    commandCount: 5,
    bufferSize: 1024,
    uptimeSeconds: 100.0,
    state: SessionState.ACTIVE,
    error: null,
    ...overrides,
  };
}

function makeMetrics(sessionId = "session-1"): SessionDetailedMetrics {
  return {
    session_id: sessionId,
    state: SessionState.ACTIVE,
    is_alive: true,
    created_at: NOW,
    last_activity: NOW,
    uptime_seconds: 1,
    idle_seconds: 0,
    commands: { total_executed: 1, current_count: 1, history_length: 1 },
    performance: { total_cpu_time: 0.1, peak_memory_mb: 10, current_memory_mb: 8 },
    buffer: { current_size: 0, max_size: 1024, utilization_percent: 0 },
    timeout: { configured_seconds: null, is_timed_out: false },
  };
}

function makeManagerMetrics(): ManagerMetrics {
  return {
    manager: { total_sessions: 1, active_sessions: 1, terminated_sessions: 0, max_sessions: 50, utilization_percent: 2 },
    aggregate: { total_commands: 5, total_cpu_time: 0.5, total_memory_mb: 8, avg_memory_per_session: 8 },
    sessions: [makeMetrics()],
  };
}

interface MockManager extends Record<string, Mock> {
  createSession: Mock;
  executeCommand: Mock;
  listSessions: Mock;
  getSessionInfo: Mock;
  terminateSession: Mock;
  inspectSession: Mock;
  getSessionHistory: Mock;
  sessionMetrics: Mock;
}

function makeMockManager(): MockManager {
  return {
    createSession: vi.fn().mockResolvedValue("session-1"),
    executeCommand: vi.fn().mockResolvedValue(makeExecResult()),
    listSessions: vi.fn().mockResolvedValue([]),
    getSessionInfo: vi.fn().mockResolvedValue(makeSessionInfo()),
    terminateSession: vi.fn().mockResolvedValue(undefined),
    inspectSession: vi.fn().mockResolvedValue(makeMetrics()),
    getSessionHistory: vi.fn().mockResolvedValue([]),
    sessionMetrics: vi.fn().mockResolvedValue(makeManagerMetrics()),
  };
}

// ---------------------------------------------------------------------------
// QueryShellTool
// ---------------------------------------------------------------------------

describe("QueryShellTool", () => {
  let mgr: MockManager;
  let tool: QueryShellTool;

  beforeEach(() => {
    mgr = makeMockManager();
    tool = new QueryShellTool(mgr as unknown as OpenROADManager);
  });

  it("auto-creates a session when sessionId is null", async () => {
    const raw = await tool.execute("help", null);
    const result = JSON.parse(raw);
    expect(mgr.createSession).toHaveBeenCalledOnce();
    expect(result.output).toBe("test output");
    expect(result.session_id).toBe("session-1");
  });

  it("uses an existing session without creating a new one", async () => {
    const raw = await tool.execute("help", "session-1");
    JSON.parse(raw);
    expect(mgr.createSession).not.toHaveBeenCalled();
    expect(mgr.executeCommand).toHaveBeenCalledWith("session-1", "help", undefined);
  });

  it("returns snake_case keys in JSON output", async () => {
    const raw = await tool.execute("help", "session-1");
    const result = JSON.parse(raw);
    expect(Object.keys(result)).toContain("session_id");
    expect(Object.keys(result)).toContain("execution_time");
    expect(Object.keys(result)).toContain("command_count");
    expect(Object.keys(result)).toContain("buffer_size");
  });

  it("handles SessionNotFoundError", async () => {
    mgr.executeCommand.mockRejectedValue(new SessionNotFoundError("not found", "session-1"));
    const raw = await tool.execute("help", "session-1");
    const result = JSON.parse(raw);
    expect(result.output).toBe("Error: Session 'session-1' not found.");
    expect(result.error).toContain("not found");
  });

  it("handles SessionTerminatedError", async () => {
    mgr.executeCommand.mockRejectedValue(new SessionTerminatedError("terminated", "session-1"));
    const raw = await tool.execute("help", "session-1");
    const result = JSON.parse(raw);
    expect(result.output).toBe("");
    expect(result.error).toContain("terminated");
  });

  it("handles unexpected errors", async () => {
    mgr.executeCommand.mockRejectedValue(new Error("boom"));
    const raw = await tool.execute("help", "session-1");
    const result = JSON.parse(raw);
    expect(result.error).toContain("Unexpected error");
    expect(result.error).toContain("boom");
  });

  it("blocks dangerous commands when whitelist is enabled", async () => {
    // `quit` is in BLOCKED_COMMANDS
    const raw = await tool.execute("quit");
    const result = JSON.parse(raw);
    expect(result.error).toMatch(/CommandBlocked/);
    expect(mgr.executeCommand).not.toHaveBeenCalled();
  });

  it("InteractiveShellTool is an alias for QueryShellTool", () => {
    expect(InteractiveShellTool).toBe(QueryShellTool);
  });
});

// ---------------------------------------------------------------------------
// ExecShellTool
// ---------------------------------------------------------------------------

describe("ExecShellTool", () => {
  let mgr: MockManager;
  let tool: ExecShellTool;

  beforeEach(() => {
    mgr = makeMockManager();
    tool = new ExecShellTool(mgr as unknown as OpenROADManager);
  });

  it("executes a state-modifying command", async () => {
    const raw = await tool.execute("set_wire_rc -signal -layer metal3", "session-1");
    const result = JSON.parse(raw);
    expect(result.output).toBe("test output");
    expect(mgr.createSession).not.toHaveBeenCalled();
  });

  it("blocks quit via BLOCKED_COMMANDS", async () => {
    const raw = await tool.execute("quit");
    const result = JSON.parse(raw);
    expect(result.error).toMatch(/CommandBlocked/);
  });

  it("handles SessionNotFoundError", async () => {
    mgr.executeCommand.mockRejectedValue(new SessionNotFoundError("missing", "session-1"));
    const raw = await tool.execute("read_lef foo.lef", "session-1");
    const result = JSON.parse(raw);
    expect(result.output).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// ListSessionsTool
// ---------------------------------------------------------------------------

describe("ListSessionsTool", () => {
  let mgr: MockManager;
  let tool: ListSessionsTool;

  beforeEach(() => {
    mgr = makeMockManager();
    tool = new ListSessionsTool(mgr as unknown as OpenROADManager);
  });

  it("returns empty list when no sessions exist", async () => {
    const raw = await tool.execute();
    const result = JSON.parse(raw);
    expect(result.sessions).toEqual([]);
    expect(result.total_count).toBe(0);
    expect(result.active_count).toBe(0);
    expect(result.error).toBeNull();
  });

  it("counts only alive sessions in active_count", async () => {
    mgr.listSessions.mockResolvedValue([
      makeSessionInfo({ sessionId: "s1", isAlive: true }),
      makeSessionInfo({ sessionId: "s2", isAlive: false }),
      makeSessionInfo({ sessionId: "s3", isAlive: true }),
    ]);
    const raw = await tool.execute();
    const result = JSON.parse(raw);
    expect(result.total_count).toBe(3);
    expect(result.active_count).toBe(2);
  });

  it("returns error field on exception", async () => {
    mgr.listSessions.mockRejectedValue(new Error("db error"));
    const raw = await tool.execute();
    const result = JSON.parse(raw);
    expect(result.error).toBeTruthy();
    expect(result.sessions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CreateSessionTool
// ---------------------------------------------------------------------------

describe("CreateSessionTool", () => {
  let mgr: MockManager;
  let tool: CreateSessionTool;

  beforeEach(() => {
    mgr = makeMockManager();
    tool = new CreateSessionTool(mgr as unknown as OpenROADManager);
  });

  it("creates a session with default parameters", async () => {
    const raw = await tool.execute();
    const result = JSON.parse(raw);
    expect(mgr.createSession).toHaveBeenCalledOnce();
    expect(result.session_id).toBe("session-1");
    expect(result.is_alive).toBe(true);
  });

  it("passes custom parameters to createSession", async () => {
    await tool.execute("my-id", ["openroad"], { KEY: "VAL" }, "/tmp");
    expect(mgr.createSession).toHaveBeenCalledWith({
      sessionId: "my-id",
      command: ["openroad"],
      env: { KEY: "VAL" },
      cwd: "/tmp",
    });
  });

  it("returns error info when creation fails", async () => {
    mgr.createSession.mockRejectedValue(new SessionError("limit reached"));
    const raw = await tool.execute("my-id");
    const result = JSON.parse(raw);
    expect(result.is_alive).toBe(false);
    expect(result.error).toContain("limit reached");
  });
});

// ---------------------------------------------------------------------------
// TerminateSessionTool
// ---------------------------------------------------------------------------

describe("TerminateSessionTool", () => {
  let mgr: MockManager;
  let tool: TerminateSessionTool;

  beforeEach(() => {
    mgr = makeMockManager();
    tool = new TerminateSessionTool(mgr as unknown as OpenROADManager);
  });

  it("terminates a session normally", async () => {
    const raw = await tool.execute("session-1");
    const result = JSON.parse(raw);
    expect(result.terminated).toBe(true);
    expect(result.was_alive).toBe(true);
    expect(result.force).toBe(false);
    expect(result.error).toBeNull();
  });

  it("force-terminates a session", async () => {
    const raw = await tool.execute("session-1", true);
    const result = JSON.parse(raw);
    expect(result.force).toBe(true);
    expect(result.terminated).toBe(true);
  });

  it("handles terminating a non-existent session", async () => {
    mgr.getSessionInfo.mockRejectedValue(new SessionNotFoundError("not found", "session-1"));
    mgr.terminateSession.mockRejectedValue(new SessionNotFoundError("not found", "session-1"));
    const raw = await tool.execute("session-1");
    const result = JSON.parse(raw);
    expect(result.terminated).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("handles unexpected termination errors", async () => {
    mgr.terminateSession.mockRejectedValue(new Error("PTY crash"));
    const raw = await tool.execute("session-1");
    const result = JSON.parse(raw);
    expect(result.terminated).toBe(false);
    expect(result.error).toContain("Termination failed");
  });
});

// ---------------------------------------------------------------------------
// InspectSessionTool
// ---------------------------------------------------------------------------

describe("InspectSessionTool", () => {
  let mgr: MockManager;
  let tool: InspectSessionTool;

  beforeEach(() => {
    mgr = makeMockManager();
    tool = new InspectSessionTool(mgr as unknown as OpenROADManager);
  });

  it("returns session metrics", async () => {
    const raw = await tool.execute("session-1");
    const result = JSON.parse(raw);
    expect(result.session_id).toBe("session-1");
    expect(result.metrics).toBeTruthy();
    expect(result.metrics.session_id).toBe("session-1");
    expect(result.error).toBeNull();
  });

  it("returns error when session not found", async () => {
    mgr.inspectSession.mockRejectedValue(new SessionNotFoundError("missing", "session-1"));
    const raw = await tool.execute("session-1");
    const result = JSON.parse(raw);
    expect(result.metrics).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("returns error on unexpected failure", async () => {
    mgr.inspectSession.mockRejectedValue(new Error("cpu panic"));
    const raw = await tool.execute("session-1");
    const result = JSON.parse(raw);
    expect(result.error).toContain("Inspection failed");
  });
});

// ---------------------------------------------------------------------------
// SessionHistoryTool
// ---------------------------------------------------------------------------

describe("SessionHistoryTool", () => {
  let mgr: MockManager;
  let tool: SessionHistoryTool;

  beforeEach(() => {
    mgr = makeMockManager();
    tool = new SessionHistoryTool(mgr as unknown as OpenROADManager);
  });

  it("returns session history", async () => {
    mgr.getSessionHistory.mockResolvedValue([
      { command: "help", timestamp: NOW, command_number: 1, execution_start: 0 },
    ]);
    const raw = await tool.execute("session-1");
    const result = JSON.parse(raw);
    expect(result.session_id).toBe("session-1");
    expect(result.total_commands).toBe(1);
    expect(result.history).toHaveLength(1);
    expect(result.error).toBeNull();
  });

  it("passes limit and search parameters", async () => {
    await tool.execute("session-1", 10, "report");
    expect(mgr.getSessionHistory).toHaveBeenCalledWith("session-1", 10, "report");
  });

  it("returns error when session not found", async () => {
    mgr.getSessionHistory.mockRejectedValue(new SessionNotFoundError("gone", "session-1"));
    const raw = await tool.execute("session-1");
    const result = JSON.parse(raw);
    expect(result.history).toEqual([]);
    expect(result.total_commands).toBe(0);
    expect(result.error).toBeTruthy();
  });

  it("returns error on unexpected failure", async () => {
    mgr.getSessionHistory.mockRejectedValue(new Error("disk full"));
    const raw = await tool.execute("session-1");
    const result = JSON.parse(raw);
    expect(result.error).toContain("History retrieval failed");
  });
});

// ---------------------------------------------------------------------------
// SessionMetricsTool
// ---------------------------------------------------------------------------

describe("SessionMetricsTool", () => {
  let mgr: MockManager;
  let tool: SessionMetricsTool;

  beforeEach(() => {
    mgr = makeMockManager();
    tool = new SessionMetricsTool(mgr as unknown as OpenROADManager);
  });

  it("returns manager-wide metrics", async () => {
    const raw = await tool.execute();
    const result = JSON.parse(raw);
    expect(result.metrics).toBeTruthy();
    expect(result.metrics.manager.total_sessions).toBe(1);
    expect(result.error).toBeNull();
  });

  it("returns error on unexpected failure", async () => {
    mgr.sessionMetrics.mockRejectedValue(new Error("overload"));
    const raw = await tool.execute();
    const result = JSON.parse(raw);
    expect(result.metrics).toBeNull();
    expect(result.error).toContain("Metrics retrieval failed");
  });
});

// ---------------------------------------------------------------------------
// Integration: full workflow
// ---------------------------------------------------------------------------

describe("Integration: session workflow", () => {
  it("create → execute → list → terminate", async () => {
    const mgr = makeMockManager();
    mgr.listSessions.mockResolvedValue([makeSessionInfo()]);

    const created = JSON.parse(await new CreateSessionTool(mgr as unknown as OpenROADManager).execute("test-id"));
    expect(created.session_id).toBe("session-1");

    const exec = JSON.parse(await new QueryShellTool(mgr as unknown as OpenROADManager).execute("help", "session-1"));
    expect(exec.output).toBe("test output");

    const list = JSON.parse(await new ListSessionsTool(mgr as unknown as OpenROADManager).execute());
    expect(list.total_count).toBe(1);

    const term = JSON.parse(await new TerminateSessionTool(mgr as unknown as OpenROADManager).execute("session-1"));
    expect(term.terminated).toBe(true);
  });

  it("concurrent operations complete without interference", async () => {
    const mgr = makeMockManager();
    const queryTool = new QueryShellTool(mgr as unknown as OpenROADManager);
    const [r1, r2, r3] = await Promise.all([
      queryTool.execute("help", "session-1"),
      queryTool.execute("version", "session-1"),
      queryTool.execute("report_checks", "session-1"),
    ]);
    expect(JSON.parse(r1).output).toBe("test output");
    expect(JSON.parse(r2).output).toBe("test output");
    expect(JSON.parse(r3).output).toBe("test output");
  });
});

// ---------------------------------------------------------------------------
// Snapshot: one representative output per tool
// ---------------------------------------------------------------------------

describe("Snapshots: wire format stability", () => {
  it("QueryShellTool success output", async () => {
    const mgr = makeMockManager();
    const raw = await new QueryShellTool(mgr as unknown as OpenROADManager).execute("help", "session-1");
    expect(raw).toMatchSnapshot();
  });

  it("ListSessionsTool with sessions", async () => {
    const mgr = makeMockManager();
    mgr.listSessions.mockResolvedValue([makeSessionInfo()]);
    const raw = await new ListSessionsTool(mgr as unknown as OpenROADManager).execute();
    expect(raw).toMatchSnapshot();
  });
});
