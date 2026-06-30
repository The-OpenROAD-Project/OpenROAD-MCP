import pidusage from "pidusage";
import { Mutex } from "async-mutex";
import { ANSIDecoder } from "../utils/ansi_decoder.js";
import { getLogger } from "../utils/logging.js";
import { getSettings } from "../config/settings.js";
import type { Settings } from "../config/settings.js";
import { SessionState } from "../core/models.js";
import type {
  CommandHistoryEntry,
  InteractiveExecResult,
  InteractiveSessionInfo,
  SessionDetailedMetrics,
} from "../core/models.js";
import {
  BYTES_TO_MB,
  MAX_COMMAND_COMPLETION_WINDOW,
  MAX_COMMAND_HISTORY,
  UTILIZATION_PERCENTAGE_BASE,
} from "../constants.js";
import { CircularBuffer } from "./buffer.js";
import { SessionError, SessionTerminatedError } from "./models.js";
import { PtyHandler } from "./pty_handler.js";

const ERROR_PATTERNS: Array<[RegExp, string]> = [
  [/invalid command name "([^"]+)"/i, "Invalid command: {0}"],
  [/wrong # args: should be "([^"]+)"/i, "Wrong arguments for command: {0}"],
  [/can't read file "?([^".\s]+)"?\.?\s*$/im, "Cannot read file: {0}"],
  [/cannot read file ([^\s.]+)\.?\s*$/im, "Cannot read file: {0}"],
  [/No such file or directory: ([^\s]+)/i, "File not found: {0}"],
  [/Permission denied: ([^\s]+)/i, "Permission denied: {0}"],
  [/Error: ([^.]+\.lib[^.]*)\s+not found/i, "Liberty file not found: {0}"],
  [/Error: ([^.]+\.lef[^.]*)\s+not found/i, "LEF file not found: {0}"],
  [/Error: design ([^\s]+) not found/i, "Design not found: {0}"],
  [/Error: instance ([^\s]+) not found/i, "Instance not found: {0}"],
  [/Error: net ([^\s]+) not found/i, "Net not found: {0}"],
  [/Error: clock ([^\s]+) not found/i, "Clock not found: {0}"],
  [/Error: no clocks defined/i, "No clocks defined"],
  [/Error: (.+?)(?:\r?\n|$)/im, "Error: {0}"],
  [/ERROR: (.+?)(?:\r?\n|$)/m, "Error: {0}"],
  [/FATAL: (.+?)(?:\r?\n|$)/m, "Fatal error: {0}"],
  [/while evaluating (.+?)(?:\r?\n|$)/im, "Command evaluation failed: {0}"],
];

export class InteractiveSession {
  readonly sessionId: string;
  readonly createdAt: Date;
  commandCount = 0;

  // Activity / history / performance tracking (consumed by the manager).
  lastActivity: Date = new Date();
  readonly commandHistory: CommandHistoryEntry[] = [];
  totalCpuTime = 0;
  peakMemoryMb = 0;
  totalCommandsExecuted = 0;
  sessionTimeoutSeconds: number | null = null;

  private _state: SessionState;
  // Wall-clock time the process actually died, set on the first TERMINATED
  // transition. Used by the manager's force-cleanup timer; lastActivity would
  // be wrong because a long-idle session dies far after its last command.
  private _terminatedAt: Date | null = null;
  pty: PtyHandler;
  readonly outputBuffer: CircularBuffer;

  private _inputQueue: string[] = [];
  private _inputWaiters: Array<() => void> = [];
  private _isShutdown = false;
  private _writerTask: Promise<void> | null = null;
  // Serialises terminate()/cleanup() so concurrent callers cannot double-kill
  // the process or deliver a stale exit code to waiters.
  private readonly _lifecycleLock = new Mutex();

  constructor(sessionId: string, bufferSize?: number, private readonly _settings: Settings = getSettings()) {
    this.sessionId = sessionId;
    this.createdAt = new Date();
    this._state = SessionState.CREATING;
    this.pty = new PtyHandler(_settings);
    this.outputBuffer = new CircularBuffer(bufferSize ?? _settings.DEFAULT_BUFFER_SIZE);
  }

  get state(): SessionState {
    return this._state;
  }

  set state(value: SessionState) {
    if (value === SessionState.TERMINATED && this._terminatedAt === null) {
      this._terminatedAt = new Date();
    }
    this._state = value;
  }

  /** Wall-clock time the session first became TERMINATED, or null if still alive. */
  get terminatedAt(): Date | null {
    return this._terminatedAt;
  }

  /**
   * Check whether the session is alive, syncing state as a side effect.
   * If the underlying PTY process has died since the last check, this
   * transitions _state to TERMINATED and signals the writer to stop.
   * Named checkAlive (not isAlive) to signal that it is not a pure predicate.
   */
  checkAlive(): boolean {
    if (this._state === SessionState.TERMINATED) return false;

    const processAlive = this.pty.isProcessAlive();
    if (!processAlive && this._state === SessionState.ACTIVE) {
      this.state = SessionState.TERMINATED;
      this._signalShutdown();
      return false;
    }

    return this._state === SessionState.ACTIVE && processAlive;
  }

  isRunning(): boolean {
    return this._writerTask !== null && !this._isShutdown;
  }

  inputQueueSize(): number {
    return this._inputQueue.length;
  }

  async start(command?: string[], env?: Record<string, string>, cwd?: string): Promise<void> {
    if (this._state !== SessionState.CREATING) {
      throw new SessionError(`Cannot start session in state ${this._state}`, this.sessionId);
    }

    try {
      const cmd = command ?? ["openroad", "-no_init"];

      await this.pty.createSession(
        cmd,
        env,
        cwd,
        (data: string) => {
          // node-pty delivers data in push-based bursts with no size limit.
          // Slicing large deliveries keeps individual buffer chunks small so the
          // circular buffer's eviction logic bounds memory correctly.
          const appendChunk = (chunk: string): void => {
            this.outputBuffer.append(chunk).catch(() => {
              this._markDead();
              this._signalShutdown();
            });
          };
          const chunkSize = Math.max(1, Math.min(this._settings.READ_CHUNK_SIZE, this.outputBuffer.maxSize));
          if (data.length <= chunkSize) {
            appendChunk(data);
          } else {
            for (let i = 0; i < data.length; i += chunkSize) {
              appendChunk(data.slice(i, i + chunkSize));
            }
          }
        },
        (_exitCode: number) => {
          if (this._state !== SessionState.TERMINATED) {
            this.state = SessionState.TERMINATED;
            this._signalShutdown();
          }
        },
      );

      // Only promote to ACTIVE if the session is still creating. A fast process
      // death during startup may already have flipped us to TERMINATED via the
      // onData/onExit handlers; do not resurrect it into an undead ACTIVE state.
      if (this._state === SessionState.CREATING) {
        this._state = SessionState.ACTIVE;
      }
      this._writerTask = this._writeInput();
    } catch (e) {
      this._state = SessionState.ERROR;
      await this.cleanup();
      throw new SessionError(`Failed to start session: ${e}`, this.sessionId);
    }
  }

  async sendCommand(command: string): Promise<void> {
    if (!this.checkAlive()) {
      throw new SessionTerminatedError(`Session ${this.sessionId} is not active`, this.sessionId);
    }

    if (this._inputQueue.length >= this._settings.SESSION_QUEUE_SIZE) {
      throw new SessionError(
        `Input queue full (${this._settings.SESSION_QUEUE_SIZE} commands pending)`,
        this.sessionId,
      );
    }

    // Record the command in history before bumping the counters so the entry's
    // command_number matches Python (command_count + 1).
    this.commandHistory.push({
      command: command.trim(),
      timestamp: new Date().toISOString(),
      commandNumber: this.commandCount + 1,
      executionStart: Date.now() / 1000,
    });
    // Bound history so a long-lived session cannot grow it without limit.
    // command_number keeps increasing, so dropping the oldest entry is safe.
    if (this.commandHistory.length > MAX_COMMAND_HISTORY) {
      this.commandHistory.shift();
    }

    const data = command.endsWith("\n") ? command : command + "\n";
    this._inputQueue.push(data);
    this.commandCount++;
    this.totalCommandsExecuted++;
    this.lastActivity = new Date();

    const waiters = this._inputWaiters.splice(0);
    for (const w of waiters) w();
  }

  async readOutput(timeoutMs = 1000): Promise<InteractiveExecResult> {
    const startTime = Date.now();

    if (!this.checkAlive()) {
      // Drain-before-reject: a fast-exiting command (e.g. "exit") can flip
      // _state to TERMINATED between sendCommand and readOutput because
      // sendCommand is synchronous and the event loop runs onExit at the
      // next await boundary.  Node.js drains all microtasks before firing
      // onExit, so any preceding onData appends are already in the buffer.
      // Return whatever is buffered rather than discarding it.
      // Also signal shutdown here so the writer task is guaranteed to stop
      // even when readOutput() is the first caller to observe the dead state.
      this._signalShutdown();
      const chunks = await this.outputBuffer.drainAll();
      if (chunks.length === 0) {
        throw new SessionTerminatedError(`Session ${this.sessionId} is not active`, this.sessionId);
      }
      const rawOutput = chunks.join("");
      const output = ANSIDecoder.cleanOpenroadOutput(rawOutput);
      const executionTime = (Date.now() - startTime) / 1000;
      this._recordReadResult(output.length, executionTime);
      return {
        output,
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
        executionTime,
        commandCount: this.commandCount,
        bufferSize: this.outputBuffer.size,
        error: this._detectErrors(output) ?? null,
      };
    }

    const collected: string[] = [];

    while (Date.now() - startTime < timeoutMs) {
      const chunks = await this.outputBuffer.drainAll();
      if (chunks.length > 0) collected.push(...chunks);

      if (collected.length > 0) {
        const remaining = timeoutMs - (Date.now() - startTime);
        const completionWindow = Math.min(MAX_COMMAND_COMPLETION_WINDOW * 1000, remaining);
        if (completionWindow > 0) {
          const arrived = await this.outputBuffer.waitForData(completionWindow);
          if (!arrived) break;
        } else {
          break;
        }
      } else {
        const remaining = timeoutMs - (Date.now() - startTime);
        if (remaining <= 0) break;
        const arrived = await this.outputBuffer.waitForData(remaining);
        if (!arrived) break;
      }
    }

    const rawOutput = collected.join("");
    const executionTime = (Date.now() - startTime) / 1000;
    const output = ANSIDecoder.cleanOpenroadOutput(rawOutput);

    await this._updatePerformanceMetrics();
    this._recordReadResult(output.length, executionTime);

    return {
      output,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      executionTime,
      commandCount: this.commandCount,
      bufferSize: this.outputBuffer.size,
      error: this._detectErrors(output) ?? null,
    };
  }

  async getInfo(): Promise<InteractiveSessionInfo> {
    const uptime = (Date.now() - this.createdAt.getTime()) / 1000;
    return {
      sessionId: this.sessionId,
      createdAt: this.createdAt.toISOString(),
      isAlive: this.checkAlive(),
      commandCount: this.commandCount,
      bufferSize: this.outputBuffer.size,
      uptimeSeconds: uptime,
      state: this._state,
    };
  }

  async terminate(force = false): Promise<void> {
    await this._lifecycleLock.runExclusive(async () => {
      if (this._state === SessionState.TERMINATED) return;

      if (this._inputQueue.length > 0) {
        getLogger("session").warn(
          `Session ${this.sessionId}: discarding ${this._inputQueue.length} pending command(s) on terminate`,
        );
        this._inputQueue.length = 0;
      }
      this.state = SessionState.TERMINATED;
      this._signalShutdown();

      await this.pty.terminateProcess(force);
      await this.pty.cleanup();

      if (this._writerTask !== null) {
        await this._writerTask;
        this._writerTask = null;
      }
    });
  }

  async cleanup(): Promise<void> {
    await this._lifecycleLock.runExclusive(async () => {
      if (this._state !== SessionState.TERMINATED && this._state !== SessionState.ERROR) {
        this.state = SessionState.TERMINATED;
      }
      this._signalShutdown();

      if (this._writerTask !== null) {
        await this._writerTask;
        this._writerTask = null;
      }

      await this.pty.cleanup();
      await this.outputBuffer.clear();
    });
  }

  private _signalShutdown(): void {
    this._isShutdown = true;
    const waiters = this._inputWaiters.splice(0);
    for (const w of waiters) w();
  }

  /**
   * Transition to TERMINATED from any non-terminal state (idempotent). Covers
   * CREATING as well as ACTIVE so a session that dies mid-startup is never left
   * stranded as an uncollectable CREATING zombie.
   */
  private _markDead(): void {
    if (this._state !== SessionState.TERMINATED && this._state !== SessionState.ERROR) {
      this.state = SessionState.TERMINATED;
    }
  }

  private async _writeInput(): Promise<void> {
    while (!this._isShutdown) {
      const data = await this._dequeueInput(1000);
      if (this._isShutdown) break;
      if (data !== null) {
        try {
          this.pty.writeInput(data);
        } catch {
          this._markDead();
          this._signalShutdown();
          break;
        }
      }
    }
  }

  private _dequeueInput(timeoutMs: number): Promise<string | null> {
    if (this._inputQueue.length > 0) {
      return Promise.resolve(this._inputQueue.shift()!);
    }

    return new Promise<string | null>((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this._inputWaiters.indexOf(wakeUp);
        if (idx !== -1) this._inputWaiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);

      const wakeUp = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(this._inputQueue.shift() ?? null);
      };

      this._inputWaiters.push(wakeUp);
    });
  }

  private _detectErrors(output: string): string | undefined {
    if (!output) return undefined;

    for (const [pattern, template] of ERROR_PATTERNS) {
      const match = pattern.exec(output);
      if (match) {
        const capture = match[1];
        // Function replacement so `$&`/`$1`/`$$` inside the captured error text
        // are inserted literally, not reinterpreted as replacement patterns.
        return capture ? template.replace("{0}", () => capture.trim()) : template;
      }
    }

    return undefined;
  }

  /**
   * Update lastActivity and backfill history entries after a read. Walks back
   * over every trailing entry still missing execution_time, stopping at the
   * first already-recorded one, so commands batched into a single readOutput
   * all get timing instead of only the most recent.
   */
  private _recordReadResult(outputLength: number, executionTime: number): void {
    for (let i = this.commandHistory.length - 1; i >= 0; i--) {
      const entry = this.commandHistory[i];
      if (!entry || entry.executionTime !== undefined) break;
      entry.executionTime = executionTime;
      entry.outputLength = outputLength;
    }
    this.lastActivity = new Date();
  }

  /** Sample CPU/memory from the live process. Best-effort; silently ignores a
   * dead or inaccessible PID. CPU time is cumulative (assigned, not summed).
   * Returns current memory MB so callers can avoid a second pidusage() call. */
  private async _updatePerformanceMetrics(): Promise<number> {
    const pid = this.pty.pid;
    if (pid == null) return 0;
    try {
      const usage = await pidusage(pid);
      this.totalCpuTime = usage.ctime / 1000;
      const currentMemoryMb = Math.max(0, usage.memory) / BYTES_TO_MB;
      this.peakMemoryMb = Math.max(this.peakMemoryMb, currentMemoryMb);
      return currentMemoryMb;
    } catch {
      return 0;
    }
  }

  /** True when a configured per-session timeout has been exceeded by uptime.
   * Distinct from idle timeout - this is wall-clock lifetime, not inactivity. */
  private _checkSessionTimeout(): boolean {
    if (this.sessionTimeoutSeconds === null) return false;
    const uptime = (Date.now() - this.createdAt.getTime()) / 1000;
    return uptime > this.sessionTimeoutSeconds;
  }

  async getDetailedMetrics(): Promise<SessionDetailedMetrics> {
    const currentMemoryMb = await this._updatePerformanceMetrics();
    const now = Date.now();
    const uptimeSeconds = (now - this.createdAt.getTime()) / 1000;
    const idleSeconds = (now - this.lastActivity.getTime()) / 1000;
    const bufferSize = this.outputBuffer.size;
    const maxSize = this.outputBuffer.maxSize;

    return {
      sessionId: this.sessionId,
      state: this._state,
      isAlive: this.checkAlive(),
      createdAt: this.createdAt.toISOString(),
      lastActivity: this.lastActivity.toISOString(),
      uptimeSeconds,
      idleSeconds,
      commands: {
        totalExecuted: this.totalCommandsExecuted,
        currentCount: this.commandCount,
        historyLength: this.commandHistory.length,
      },
      performance: {
        totalCpuTime: this.totalCpuTime,
        peakMemoryMb: this.peakMemoryMb,
        currentMemoryMb,
      },
      buffer: {
        currentSize: bufferSize,
        maxSize,
        utilizationPercent: maxSize > 0 ? (bufferSize / maxSize) * UTILIZATION_PERCENTAGE_BASE : 0,
      },
      timeout: {
        configuredSeconds: this.sessionTimeoutSeconds,
        isTimedOut: this._checkSessionTimeout(),
      },
    };
  }

  getCommandHistory(limit?: number, search?: string): CommandHistoryEntry[] {
    let history = [...this.commandHistory];

    if (search) {
      const needle = search.toLowerCase();
      history = history.filter((cmd) => cmd.command.toLowerCase().includes(needle));
    }

    // Sort by timestamp, most recent first.
    history.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

    // Only a positive limit slices. A zero or negative limit leaves the list
    // intact rather than letting `slice(0, -n)` silently drop recent entries.
    if (limit !== undefined && limit > 0) {
      history = history.slice(0, limit);
    }

    return history;
  }

  async replayCommand(commandNumber: number): Promise<string> {
    for (const cmd of this.commandHistory) {
      if (cmd.commandNumber === commandNumber) {
        await this.sendCommand(cmd.command);
        return cmd.command;
      }
    }
    throw new SessionError(`Command ${commandNumber} not found in history`, this.sessionId);
  }

  setSessionTimeout(timeoutSeconds: number): void {
    this.sessionTimeoutSeconds = timeoutSeconds;
  }

  isIdleTimeout(idleThresholdSeconds: number = this._settings.SESSION_IDLE_TIMEOUT): boolean {
    const idleTime = (Date.now() - this.lastActivity.getTime()) / 1000;
    return idleTime > idleThresholdSeconds;
  }

  async filterOutput(pattern: string, maxLines = 1000): Promise<string[]> {
    const chunks = await this.outputBuffer.peekAll();
    if (chunks.length === 0) return [];

    const text = this.outputBuffer.toText(chunks);
    const lines = text.split("\n");

    let matching: string[];
    try {
      const regex = new RegExp(pattern, "i");
      matching = lines.filter((line) => regex.test(line));
    } catch {
      // Fallback to a case-insensitive substring search on invalid regex.
      const needle = pattern.toLowerCase();
      matching = lines.filter((line) => line.toLowerCase().includes(needle));
    }

    return matching.length > 0 ? matching.slice(-maxLines) : [];
  }
}
