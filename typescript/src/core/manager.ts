import { Mutex } from "async-mutex";
import { randomUUID } from "node:crypto";
import { getSettings } from "../config/settings.js";
import type { Settings } from "../config/settings.js";
import { getLogger } from "../utils/logging.js";
import { InteractiveSession } from "../interactive/session.js";
import { SessionError, SessionNotFoundError } from "../interactive/models.js";
import type {
  CommandHistoryEntry,
  InteractiveExecResult,
  InteractiveSessionInfo,
  ManagerMetrics,
  SessionDetailedMetrics,
} from "./models.js";

/** Time after which a dead session is force-removed even if cleanup fails. */
const FORCE_CLEANUP_AFTER_SECONDS = 60;

export interface CreateSessionOptions {
  sessionId?: string;
  command?: string[];
  env?: Record<string, string>;
  cwd?: string;
  bufferSize?: number;
}

/**
 * Manages OpenROAD subprocess lifecycle and interactive sessions.
 *
 * The async-mutex `cleanupLock` serialises the multi-await cleanup/creation
 * sections so concurrent callers cannot interleave session-map mutations
 * across await points.
 */
export class OpenROADManager {
  private readonly logger = getLogger("manager");
  private readonly sessions = new Map<string, InteractiveSession | null>();
  private readonly cleanupLock = new Mutex();
  private readonly settings: Settings = getSettings();
  private readonly maxSessions: number;
  private readonly defaultTimeoutMs: number;
  private readonly defaultBufferSize: number;

  constructor(maxSessions?: number) {
    this.maxSessions = maxSessions ?? this.settings.MAX_SESSIONS;
    this.defaultTimeoutMs = Math.round(this.settings.COMMAND_TIMEOUT * 1000);
    this.defaultBufferSize = this.settings.DEFAULT_BUFFER_SIZE;
    this.logger.info(`Initialized OpenROADManager with maxSessions=${this.maxSessions}`);
  }

  async createSession(opts: CreateSessionOptions = {}): Promise<string> {
    const sessionId = opts.sessionId ?? randomUUID().slice(0, 8);

    return this.cleanupLock.runExclusive(async () => {
      await this._cleanupTerminatedSessions();

      if (this.sessions.has(sessionId)) {
        throw new SessionError(`Session ${sessionId} already exists`, sessionId);
      }

      const activeCount = this._countActive();
      if (activeCount >= this.maxSessions) {
        throw new SessionError(
          `Maximum session limit reached (${this.maxSessions}). Currently ${activeCount} active sessions.`,
          sessionId,
        );
      }

      // Placeholder distinguishes "creating" (null) from "not found" (absent).
      this.sessions.set(sessionId, null);

      try {
        // 0 (and undefined) fall back to the default so a zero-capacity buffer
        // can't silently drop all output.
        const bufferSize = opts.bufferSize && opts.bufferSize > 0 ? opts.bufferSize : this.defaultBufferSize;
        const session = new InteractiveSession(sessionId, bufferSize);
        await session.start(opts.command, opts.env, opts.cwd);

        this.sessions.set(sessionId, session);
        this.logger.info(`Created session ${sessionId}, total sessions: ${this.sessions.size}`);
        return sessionId;
      } catch (e) {
        this.sessions.delete(sessionId);
        this.logger.error(`Failed to create session ${sessionId}: ${String(e)}`);
        throw new SessionError(`Failed to create session: ${String(e)}`, sessionId);
      }
    });
  }

  async executeCommand(sessionId: string, command: string, timeoutMs?: number): Promise<InteractiveExecResult> {
    const session = this._getSession(sessionId);
    // 0 (and undefined) fall back to the default rather than becoming an
    // instant timeout.
    const actualTimeout = timeoutMs && timeoutMs > 0 ? timeoutMs : this.defaultTimeoutMs;

    await session.sendCommand(command);
    return session.readOutput(actualTimeout);
  }

  async getSessionInfo(sessionId: string): Promise<InteractiveSessionInfo> {
    return this._getSession(sessionId).getInfo();
  }

  async listSessions(): Promise<InteractiveSessionInfo[]> {
    await this._cleanupTerminatedSessionsWithLock();

    const infos: InteractiveSessionInfo[] = [];
    for (const [, session] of this._initializedSessions()) {
      try {
        infos.push(await session.getInfo());
      } catch (e) {
        this.logger.warn(`Failed to get info for session ${session.sessionId}: ${String(e)}`);
      }
    }
    return infos;
  }

  async terminateSession(sessionId: string, force = false): Promise<void> {
    const session = this._getSession(sessionId);

    // Do not call cleanup() here: cleanup() clears the output buffer, which
    // would discard final output a concurrent reader may still need. The
    // session is dropped from the map below, so its buffer is GC'd anyway.
    await session.terminate(force);
    this.logger.info(`Terminated session ${sessionId}`);

    await this.cleanupLock.runExclusive(() => {
      this.sessions.delete(sessionId);
    });
  }

  async terminateAllSessions(force = false): Promise<number> {
    // Skip null placeholders: they belong to an in-flight createSession
    // (which resolves or removes them itself), so terminating them would
    // throw "still being created" and be lost.
    const sessionIds = this._initializedSessions().map(([sid]) => sid);
    if (sessionIds.length === 0) return 0;

    const results = await Promise.allSettled(
      sessionIds.map((sid) => this.terminateSession(sid, force)),
    );
    const terminated = results.filter((r) => r.status === "fulfilled").length;

    this.logger.info(`Terminated ${terminated}/${sessionIds.length} sessions`);
    return terminated;
  }

  async inspectSession(sessionId: string): Promise<SessionDetailedMetrics> {
    return this._getSession(sessionId).getDetailedMetrics();
  }

  async getSessionHistory(sessionId: string, limit?: number, search?: string): Promise<CommandHistoryEntry[]> {
    return this._getSession(sessionId).getCommandHistory(limit, search);
  }

  async replayCommand(sessionId: string, commandNumber: number): Promise<string> {
    return this._getSession(sessionId).replayCommand(commandNumber);
  }

  async filterSessionOutput(sessionId: string, pattern: string, maxLines = 1000): Promise<string[]> {
    return this._getSession(sessionId).filterOutput(pattern, maxLines);
  }

  async setSessionTimeout(sessionId: string, timeoutSeconds: number): Promise<void> {
    this._getSession(sessionId).setSessionTimeout(timeoutSeconds);
  }

  async sessionMetrics(): Promise<ManagerMetrics> {
    await this._cleanupTerminatedSessionsWithLock();

    const sessionDetails: SessionDetailedMetrics[] = [];
    let totalCommands = 0;
    let totalCpuTime = 0;
    let totalMemoryMb = 0;

    for (const [, session] of this._initializedSessions()) {
      try {
        const metrics = await session.getDetailedMetrics();
        sessionDetails.push(metrics);
        totalCommands += metrics.commands.total_executed;
        totalCpuTime += metrics.performance.total_cpu_time;
        totalMemoryMb += metrics.performance.current_memory_mb;
      } catch (e) {
        this.logger.warn(`Failed to get metrics for session ${session.sessionId}: ${String(e)}`);
      }
    }

    // Snapshot counts after the async loop so the result reflects the
    // post-cleanup state.
    const totalSessions = this.sessions.size;
    const activeSessions = this.getActiveSessionCount();
    const terminatedSessions = totalSessions - activeSessions;

    return {
      manager: {
        total_sessions: totalSessions,
        active_sessions: activeSessions,
        terminated_sessions: terminatedSessions,
        max_sessions: this.maxSessions,
        utilization_percent: this.maxSessions > 0 ? (activeSessions / this.maxSessions) * 100 : 0,
      },
      aggregate: {
        total_commands: totalCommands,
        total_cpu_time: totalCpuTime,
        total_memory_mb: totalMemoryMb,
        avg_memory_per_session: activeSessions > 0 ? totalMemoryMb / activeSessions : 0,
      },
      sessions: sessionDetails,
    };
  }

  async cleanupIdleSessions(idleThresholdSeconds = 300, force = false): Promise<number> {
    let cleaned = 0;
    for (const [sessionId, session] of this._initializedSessions()) {
      try {
        if (session.isIdleTimeout(idleThresholdSeconds)) {
          await this.terminateSession(sessionId, force);
          cleaned++;
          this.logger.info(`Cleaned up idle session ${sessionId}`);
        }
      } catch (e) {
        this.logger.error(`Error checking idle status for session ${sessionId}: ${String(e)}`);
      }
    }
    return cleaned;
  }

  async cleanupAll(): Promise<void> {
    this.logger.info("Starting OpenROAD cleanup");
    await this.terminateAllSessions(true);
    this.logger.info("OpenROAD cleanup completed");
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  getActiveSessionCount(): number {
    return this._countActive();
  }

  private _countActive(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session !== null && session.checkAlive()) count++;
    }
    return count;
  }

  private _initializedSessions(): Array<[string, InteractiveSession]> {
    const result: Array<[string, InteractiveSession]> = [];
    for (const [sid, session] of this.sessions) {
      if (session !== null) result.push([sid, session]);
    }
    return result;
  }

  private _getSession(sessionId: string): InteractiveSession {
    if (!this.sessions.has(sessionId)) {
      throw new SessionNotFoundError(`Session ${sessionId} not found`, sessionId);
    }
    const session = this.sessions.get(sessionId);
    if (session == null) {
      throw new SessionError(`Session ${sessionId} is still being created`, sessionId);
    }
    return session;
  }

  private async _cleanupTerminatedSessionsWithLock(): Promise<number> {
    return this.cleanupLock.runExclusive(() => this._cleanupTerminatedSessions());
  }

  private async _cleanupTerminatedSessions(): Promise<number> {
    const now = Date.now();
    const terminated: Array<[string, InteractiveSession, boolean]> = [];

    for (const [sessionId, session] of this._initializedSessions()) {
      if (!session.checkAlive()) {
        // Measure from death time, not lastActivity: a long-idle session
        // dies far after its last command, which would trip force-cleanup
        // immediately.
        const deathTime = (session.terminatedAt ?? session.lastActivity).getTime();
        const timeSinceDeath = (now - deathTime) / 1000;
        terminated.push([sessionId, session, timeSinceDeath > FORCE_CLEANUP_AFTER_SECONDS]);
      }
    }

    let cleaned = 0;
    for (const [sessionId, session, forceCleanup] of terminated) {
      try {
        if (forceCleanup) {
          this.logger.warn(`Force cleaning up session ${sessionId} after ${FORCE_CLEANUP_AFTER_SECONDS}s`);
          try {
            await session.cleanup();
          } catch (cleanupError) {
            this.logger.error(`Force cleanup failed for session ${sessionId}: ${String(cleanupError)}`);
          } finally {
            this.sessions.delete(sessionId);
            cleaned++;
          }
        } else {
          try {
            await session.cleanup();
          } finally {
            this.sessions.delete(sessionId);
            cleaned++;
          }
        }
      } catch (e) {
        this.logger.error(`Error during session ${sessionId} cleanup: ${String(e)}`);
        if (forceCleanup && this.sessions.has(sessionId)) {
          this.sessions.delete(sessionId);
          cleaned++;
        }
      }
    }

    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} terminated sessions`);
    }
    return cleaned;
  }
}

export const manager = new OpenROADManager();
