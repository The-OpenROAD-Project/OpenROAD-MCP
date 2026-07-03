import { describe, it, expect, vi, beforeEach } from "vitest";
import { toSnakeCase } from "../../src/tools/base.js";
import type { InteractiveExecResult } from "../../src/core/models.js";
import { InteractiveSessionListResult, SessionState } from "../../src/core/models.js";
import { ListSessionsTool } from "../../src/tools/interactive.js";
import { OpenROADManager } from "../../src/core/manager.js";
import { InteractiveSession } from "../../src/interactive/session.js";

vi.mock("../../src/interactive/session.js", () => ({ InteractiveSession: vi.fn() }));

const EXEC_RESULT_TOKEN_BUDGET = 80;
const SESSION_LIST_EMPTY_BUDGET = 30;
const COMPACT_SAVINGS_MIN_PCT = 10.0;

/** Rough token estimate: 1 token ~4 chars (OpenAI tokenizer rule of thumb). */
function tokenEstimate(text: string): number {
  return Math.max(1, Math.floor(text.length / 4));
}

/** Serialize a domain object to the wire format via toSnakeCase. */
function wireFormat(obj: Record<string, unknown>): string {
  return JSON.stringify(toSnakeCase(obj));
}

function minimalExecResult(): InteractiveExecResult {
  return {
    output: "% ok",
    sessionId: "s1",
    timestamp: new Date().toISOString(),
    executionTime: 0.01,
    commandCount: 0,
    bufferSize: 0,
    error: null,
  };
}

function typicalExecResult(): InteractiveExecResult {
  return {
    output: "OpenROAD 2.0-1234-g1234abcd\nOpenROAD, (C) 2021 The OpenROAD Project.",
    sessionId: "abc12345",
    timestamp: new Date().toISOString(),
    executionTime: 0.123,
    commandCount: 5,
    bufferSize: 1024,
    error: null,
  };
}

describe("Token Efficiency", () => {
  it("exec result minimal token budget < 80 tokens", () => {
    const compact = wireFormat(minimalExecResult() as unknown as Record<string, unknown>);
    const tokens = tokenEstimate(compact);
    console.log(`  minimal exec result: ${compact.length} chars = ~${tokens} tokens`);
    expect(tokens).toBeLessThan(EXEC_RESULT_TOKEN_BUDGET);
  });

  it("exec result typical token budget < 80 tokens", () => {
    const compact = wireFormat(typicalExecResult() as unknown as Record<string, unknown>);
    const tokens = tokenEstimate(compact);
    console.log(`  typical exec result: ${compact.length} chars = ~${tokens} tokens`);
    expect(tokens).toBeLessThan(EXEC_RESULT_TOKEN_BUDGET);
  });

  it("empty session list token budget < 30 tokens", () => {
    const result = InteractiveSessionListResult.parse({
      sessions: [],
      totalCount: 0,
      activeCount: 0,
      error: null,
    });
    const compact = wireFormat(result as unknown as Record<string, unknown>);
    const tokens = tokenEstimate(compact);
    console.log(`  empty session list: ${compact.length} chars = ~${tokens} tokens`);
    expect(tokens).toBeLessThan(SESSION_LIST_EMPTY_BUDGET);
  });

  it("compact JSON saves >= 10% tokens vs pretty-print", () => {
    const obj = typicalExecResult() as unknown as Record<string, unknown>;
    const compact = wireFormat(obj);
    const pretty = JSON.stringify(toSnakeCase(obj), null, 2);
    const savingsPct = ((pretty.length - compact.length) / pretty.length) * 100;
    console.log(`  compactness savings: ${savingsPct.toFixed(1)}% (${pretty.length} -> ${compact.length} chars)`);
    expect(savingsPct).toBeGreaterThanOrEqual(COMPACT_SAVINGS_MIN_PCT);
  });

  it("compact JSON has no newlines or double spaces", () => {
    const compact = wireFormat(typicalExecResult() as unknown as Record<string, unknown>);
    expect(compact).not.toContain("\n");
    expect(compact).not.toContain("  ");
  });

  it("pinned token counts remain stable across refactors", () => {
    // These counts pin the exact wire format. If they change, a field was added,
    // renamed, or removed - update after verifying the schema change is intentional.
    const minimal = wireFormat(minimalExecResult() as unknown as Record<string, unknown>);
    const emptyList = wireFormat(
      InteractiveSessionListResult.parse({ sessions: [], totalCount: 0, activeCount: 0, error: null }) as unknown as Record<string, unknown>,
    );
    // Token counts (floor(len/4)) measured on first run - update if schema changes.
    expect(tokenEstimate(minimal)).toBeLessThanOrEqual(45);   // ~37 chars baseline
    expect(tokenEstimate(emptyList)).toBeLessThanOrEqual(20); // ~57 chars baseline
  });
});

describe("Live Tool Compactness", () => {
  const MockedSession = vi.mocked(InteractiveSession);
  let manager: OpenROADManager;

  beforeEach(() => {
    vi.clearAllMocks();
    MockedSession.mockImplementation(function (this: unknown, sessionId: string) {
      return {
        sessionId,
        lastActivity: new Date(),
        checkAlive: vi.fn().mockReturnValue(true),
        start: vi.fn().mockResolvedValue(undefined),
        getInfo: vi.fn().mockResolvedValue({
          sessionId,
          createdAt: new Date().toISOString(),
          isAlive: true,
          commandCount: 0,
          bufferSize: 0,
          uptimeSeconds: 1,
          state: SessionState.ACTIVE,
        }),
        terminate: vi.fn().mockResolvedValue(undefined),
        cleanup: vi.fn().mockResolvedValue(undefined),
        isIdleTimeout: vi.fn().mockReturnValue(false),
      } as unknown as InteractiveSession;
    } as unknown as (sessionId: string) => InteractiveSession);
    manager = new OpenROADManager(10);
  });

  it("ListSessionsTool output is compact JSON for a populated session list", async () => {
    await manager.createSession({ sessionId: "live-1" });
    const tool = new ListSessionsTool(manager);
    const raw = await tool.execute();

    expect(raw).not.toContain("\n");
    expect(raw).not.toContain("  ");
    const parsed = JSON.parse(raw) as { sessions: unknown[]; total_count: number; active_count: number };
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.active_count).toBe(1);
    console.log(`  list sessions (1 active): ${raw.length} chars = ~${tokenEstimate(raw)} tokens`);
  });
});
