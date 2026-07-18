import { getSettings } from "../config/settings.js";
import {
  isExecCommand,
  isQueryCommand,
} from "../config/command_whitelist.js";
import type { OpenROADManager } from "../core/manager.js";
import {
  InteractiveSessionListResult,
  SessionHistoryResult,
  SessionInspectionResult,
  SessionMetricsResult,
  SessionTerminationResult,
} from "../core/models.js";
import type {
  InteractiveExecResult,
  InteractiveSessionInfo,
} from "../core/models.js";
import {
  SessionError,
  SessionNotFoundError,
  SessionTerminatedError,
} from "../interactive/models.js";
import { getLogger } from "../utils/logging.js";
import { BaseTool, toSnakeCase } from "./base.js";

const logger = getLogger("tools.interactive");

/** Single-quoted Python-style repr for embedding strings in error messages. */
function pyRepr(s: string): string {
  const escaped = s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `'${escaped}'`;
}

function blankExecResult(
  sessionId: string | null,
  error: string,
): InteractiveExecResult {
  return {
    output: "",
    sessionId,
    timestamp: new Date().toISOString(),
    executionTime: 0.0,
    commandCount: 0,
    bufferSize: 0,
    error,
  };
}

function sessionNotFoundExecResult(
  sessionId: string | null,
  error: unknown,
): InteractiveExecResult {
  return {
    output: `Error: Session '${sessionId}' not found.`,
    sessionId,
    timestamp: new Date().toISOString(),
    executionTime: 0.0,
    commandCount: 0,
    bufferSize: 0,
    error: String(error),
  };
}

function blockedError(
  command: string,
  blockedVerb: string,
  sessionId: string | null,
): string {
  const base: InteractiveExecResult = {
    output: "",
    sessionId,
    timestamp: new Date().toISOString(),
    executionTime: 0.0,
    commandCount: 0,
    bufferSize: 0,
    error: `CommandBlocked: '${blockedVerb}'`,
  };
  const message = `Command blocked: '${blockedVerb}' is not on the OpenROAD allowlist.\nFull command: ${pyRepr(command)}`;
  return JSON.stringify(toSnakeCase({ ...base, message }));
}

/**
 * Returns a serialised blocked-error JSON string when the command is rejected
 * by the Tcl whitelist, or null when it is allowed or the whitelist is off.
 */
function applyWhitelist(
  command: string,
  validator: (cmd: string) => [boolean, string | null],
  sessionId: string | null,
): string | null {
  const settings = getSettings();
  if (!settings.WHITELIST_ENABLED) return null;
  const [allowed, blockedVerb] = validator(command);
  if (!allowed && blockedVerb !== null) {
    logger.warn(
      `Command blocked: '${blockedVerb}' for session ${sessionId ?? "new"}`,
    );
    return blockedError(command, blockedVerb, sessionId);
  }
  return null;
}

/** Read-only query tool: report_*, get_*, check_*, sta, help, version, etc. */
export class QueryShellTool extends BaseTool {
  constructor(manager: OpenROADManager) {
    super(manager);
  }

  async execute(
    command: string,
    sessionId?: string | null,
    timeoutMs?: number | null,
  ): Promise<string> {
    const sid = sessionId ?? null;

    const blocked = applyWhitelist(command, isQueryCommand, sid);
    if (blocked !== null) return blocked;

    let resolvedId = sid;
    try {
      if (resolvedId === null || resolvedId === undefined) {
        resolvedId = await this.manager.createSession({});
      }
      const result = await this.manager.executeCommand(
        resolvedId,
        command,
        timeoutMs ?? undefined,
      );
      return this.formatResult(result as unknown as Record<string, unknown>);
    } catch (e) {
      // Tear down an auto-created session so executeCommand failures do not
      // leak it.
      if (sid === null && resolvedId !== null) {
        this.manager.terminateSession(resolvedId, true).catch(() => { /* best effort */ });
      }
      if (e instanceof SessionNotFoundError) {
        return this.formatResult(
          sessionNotFoundExecResult(
            resolvedId,
            e,
          ) as unknown as Record<string, unknown>,
        );
      }
      if (e instanceof SessionTerminatedError || e instanceof SessionError) {
        return this.formatResult(
          blankExecResult(
            resolvedId,
            (e as Error).message,
          ) as unknown as Record<string, unknown>,
        );
      }
      return this.formatResult(
        blankExecResult(
          resolvedId,
          `Unexpected error: ${(e as Error).message ?? String(e)}`,
        ) as unknown as Record<string, unknown>,
      );
    }
  }
}

/** State-modifying exec tool: set_*, create_*, read_*, write_*, flow/repair, etc. */
export class ExecShellTool extends BaseTool {
  constructor(manager: OpenROADManager) {
    super(manager);
  }

  async execute(
    command: string,
    sessionId?: string | null,
    timeoutMs?: number | null,
  ): Promise<string> {
    const sid = sessionId ?? null;

    const blocked = applyWhitelist(command, isExecCommand, sid);
    if (blocked !== null) return blocked;

    let resolvedId = sid;
    try {
      if (resolvedId === null || resolvedId === undefined) {
        resolvedId = await this.manager.createSession({});
      }
      const result = await this.manager.executeCommand(
        resolvedId,
        command,
        timeoutMs ?? undefined,
      );
      return this.formatResult(result as unknown as Record<string, unknown>);
    } catch (e) {
      if (sid === null && resolvedId !== null) {
        this.manager.terminateSession(resolvedId, true).catch(() => { /* best effort */ });
      }
      if (e instanceof SessionNotFoundError) {
        return this.formatResult(
          sessionNotFoundExecResult(
            resolvedId,
            e,
          ) as unknown as Record<string, unknown>,
        );
      }
      if (e instanceof SessionTerminatedError || e instanceof SessionError) {
        return this.formatResult(
          blankExecResult(
            resolvedId,
            (e as Error).message,
          ) as unknown as Record<string, unknown>,
        );
      }
      return this.formatResult(
        blankExecResult(
          resolvedId,
          `Unexpected error: ${(e as Error).message ?? String(e)}`,
        ) as unknown as Record<string, unknown>,
      );
    }
  }
}

export class ListSessionsTool extends BaseTool {
  constructor(manager: OpenROADManager) {
    super(manager);
  }

  async execute(): Promise<string> {
    try {
      const sessions = await this.manager.listSessions();
      const activeCount = sessions.filter((s) => s.isAlive).length;
      return this.formatResult(
        InteractiveSessionListResult.parse({
          sessions,
          totalCount: sessions.length,
          activeCount,
        }) as unknown as Record<string, unknown>,
      );
    } catch (e) {
      return this.formatResult(
        InteractiveSessionListResult.parse({
          error: String(e),
        }) as unknown as Record<string, unknown>,
      );
    }
  }
}

export class CreateSessionTool extends BaseTool {
  constructor(manager: OpenROADManager) {
    super(manager);
  }

  async execute(
    sessionId?: string,
    command?: string[],
    env?: Record<string, string>,
    cwd?: string,
  ): Promise<string> {
    try {
      const opts = {
        ...(sessionId !== undefined && { sessionId }),
        ...(command !== undefined && { command }),
        ...(env !== undefined && { env }),
        ...(cwd !== undefined && { cwd }),
      };
      const id = await this.manager.createSession(opts);
      const info = await this.manager.getSessionInfo(id);
      return this.formatResult(info as unknown as Record<string, unknown>);
    } catch (e) {
      const errInfo: InteractiveSessionInfo = {
        sessionId: sessionId ?? "unknown",
        createdAt: new Date().toISOString(),
        isAlive: false,
        commandCount: 0,
        bufferSize: 0,
        uptimeSeconds: null,
        state: null,
        error: String(e),
      };
      return this.formatResult(errInfo as unknown as Record<string, unknown>);
    }
  }
}

export class TerminateSessionTool extends BaseTool {
  constructor(manager: OpenROADManager) {
    super(manager);
  }

  async execute(sessionId: string, force = false): Promise<string> {
    let wasAlive = false;
    try {
      const info = await this.manager.getSessionInfo(sessionId);
      wasAlive = info.isAlive;
    } catch (e) {
      if (!(e instanceof SessionNotFoundError)) throw e;
    }

    try {
      await this.manager.terminateSession(sessionId, force);
      return this.formatResult(
        SessionTerminationResult.parse({
          sessionId,
          terminated: true,
          wasAlive,
          force,
        }) as unknown as Record<string, unknown>,
      );
    } catch (e) {
      if (e instanceof SessionNotFoundError) {
        return this.formatResult(
          SessionTerminationResult.parse({
            sessionId,
            terminated: false,
            wasAlive,
            error: String(e),
          }) as unknown as Record<string, unknown>,
        );
      }
      return this.formatResult(
        SessionTerminationResult.parse({
          sessionId,
          terminated: false,
          wasAlive,
          error: `Termination failed: ${(e as Error).message ?? String(e)}`,
        }) as unknown as Record<string, unknown>,
      );
    }
  }
}

export class InspectSessionTool extends BaseTool {
  constructor(manager: OpenROADManager) {
    super(manager);
  }

  async execute(sessionId: string): Promise<string> {
    try {
      const metrics = await this.manager.inspectSession(sessionId);
      return this.formatResult(
        SessionInspectionResult.parse({
          sessionId,
          metrics,
        }) as unknown as Record<string, unknown>,
      );
    } catch (e) {
      if (e instanceof SessionNotFoundError) {
        return this.formatResult(
          SessionInspectionResult.parse({
            sessionId,
            error: String(e),
          }) as unknown as Record<string, unknown>,
        );
      }
      return this.formatResult(
        SessionInspectionResult.parse({
          sessionId,
          error: `Inspection failed: ${(e as Error).message ?? String(e)}`,
        }) as unknown as Record<string, unknown>,
      );
    }
  }
}

export class SessionHistoryTool extends BaseTool {
  constructor(manager: OpenROADManager) {
    super(manager);
  }

  async execute(
    sessionId: string,
    limit?: number,
    search?: string,
  ): Promise<string> {
    try {
      const history = await this.manager.getSessionHistory(sessionId, limit, search);
      return this.formatResult(
        SessionHistoryResult.parse({
          sessionId,
          history,
          totalCommands: history.length,
          limit: limit ?? null,
          search: search ?? null,
        }) as unknown as Record<string, unknown>,
      );
    } catch (e) {
      if (e instanceof SessionNotFoundError) {
        return this.formatResult(
          SessionHistoryResult.parse({
            sessionId,
            error: String(e),
          }) as unknown as Record<string, unknown>,
        );
      }
      return this.formatResult(
        SessionHistoryResult.parse({
          sessionId,
          error: `History retrieval failed: ${(e as Error).message ?? String(e)}`,
        }) as unknown as Record<string, unknown>,
      );
    }
  }
}

export class SessionMetricsTool extends BaseTool {
  constructor(manager: OpenROADManager) {
    super(manager);
  }

  async execute(): Promise<string> {
    try {
      const metrics = await this.manager.sessionMetrics();
      return this.formatResult(
        SessionMetricsResult.parse({ metrics }) as unknown as Record<
          string,
          unknown
        >,
      );
    } catch (e) {
      return this.formatResult(
        SessionMetricsResult.parse({
          error: `Metrics retrieval failed: ${(e as Error).message ?? String(e)}`,
        }) as unknown as Record<string, unknown>,
      );
    }
  }
}

export const InteractiveShellTool = QueryShellTool;
