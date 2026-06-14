import { ANSIDecoder } from "../utils/ansi_decoder.js";
import { getSettings } from "../config/settings.js";
import type { Settings } from "../config/settings.js";
import { SessionState } from "../core/models.js";
import type { InteractiveExecResult, InteractiveSessionInfo } from "../core/models.js";
import { MAX_COMMAND_COMPLETION_WINDOW } from "../constants.js";
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

  private _state: SessionState;
  pty: PtyHandler;
  readonly outputBuffer: CircularBuffer;

  private _inputQueue: string[] = [];
  private _inputWaiters: Array<() => void> = [];
  private _isShutdown = false;
  private _writerTask: Promise<void> | null = null;

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
    this._state = value;
  }

  isAlive(): boolean {
    if (this._state === SessionState.TERMINATED) return false;

    const processAlive = this.pty.isProcessAlive();
    if (!processAlive && this._state === SessionState.ACTIVE) {
      this._state = SessionState.TERMINATED;
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
              if (this._state === SessionState.ACTIVE) {
                this._state = SessionState.TERMINATED;
              }
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
            this._state = SessionState.TERMINATED;
            this._signalShutdown();
          }
        },
      );

      this._state = SessionState.ACTIVE;
      this._writerTask = this._writeInput();
    } catch (e) {
      this._state = SessionState.ERROR;
      await this.cleanup();
      throw new SessionError(`Failed to start session: ${e}`, this.sessionId);
    }
  }

  async sendCommand(command: string): Promise<void> {
    if (!this.isAlive()) {
      throw new SessionTerminatedError(`Session ${this.sessionId} is not active`, this.sessionId);
    }

    if (this._inputQueue.length >= this._settings.SESSION_QUEUE_SIZE) {
      throw new SessionError(
        `Input queue full (${this._settings.SESSION_QUEUE_SIZE} commands pending)`,
        this.sessionId,
      );
    }

    const data = command.endsWith("\n") ? command : command + "\n";
    this._inputQueue.push(data);
    this.commandCount++;

    const waiters = this._inputWaiters.splice(0);
    for (const w of waiters) w();
  }

  async readOutput(timeoutMs = 1000): Promise<InteractiveExecResult> {
    const startTime = Date.now();

    if (!this.isAlive()) {
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
      return {
        output,
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
        executionTime: (Date.now() - startTime) / 1000,
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
      isAlive: this.isAlive(),
      commandCount: this.commandCount,
      bufferSize: this.outputBuffer.size,
      uptimeSeconds: uptime,
      state: this._state,
    };
  }

  async terminate(force = false): Promise<void> {
    if (this._state === SessionState.TERMINATED) return;

    this._state = SessionState.TERMINATED;
    this._signalShutdown();

    await this.pty.terminateProcess(force);
    await this.pty.cleanup();

    if (this._writerTask !== null) {
      await this._writerTask;
      this._writerTask = null;
    }
  }

  async cleanup(): Promise<void> {
    if (this._state !== SessionState.TERMINATED && this._state !== SessionState.ERROR) {
      this._state = SessionState.TERMINATED;
    }
    this._signalShutdown();

    if (this._writerTask !== null) {
      await this._writerTask;
      this._writerTask = null;
    }

    await this.pty.cleanup();
    await this.outputBuffer.clear();
  }

  private _signalShutdown(): void {
    this._isShutdown = true;
    const waiters = this._inputWaiters.splice(0);
    for (const w of waiters) w();
  }

  private async _writeInput(): Promise<void> {
    while (!this._isShutdown) {
      const data = await this._dequeueInput(1000);
      if (this._isShutdown) break;
      if (data !== null) {
        try {
          this.pty.writeInput(data);
        } catch {
          if (this._state === SessionState.ACTIVE) {
            this._state = SessionState.TERMINATED;
          }
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
        return capture ? template.replace("{0}", capture.trim()) : template;
      }
    }

    return undefined;
  }
}
