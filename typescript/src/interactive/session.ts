import pidusage from "pidusage";
import { Mutex } from "async-mutex";
import { ANSIDecoder } from "../utils/ansi_decoder.js";
import { getLogger } from "../utils/logging.js";
import { getSettings } from "../config/settings.js";
import type { Settings } from "../config/settings.js";
import { SessionState } from "../core/models.js";
import type {
  SessionGrepMatch,
  SessionGrepResult,
  SessionOutputRecord,
} from "../core/models.js";
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
  OUTPUT_HISTORY_DEFAULTS,
  PTY_LINE_TERMINATOR,
  truncationNotice,
  UTILIZATION_PERCENTAGE_BASE,
} from "../constants.js";
import { CircularBuffer } from "./buffer.js";
import { SessionError, SessionTerminatedError } from "./models.js";
import { PtyHandler } from "./pty_handler.js";

/**
 * Completion sentinel. After each user command we emit a marker line and read
 * until it appears, which is the only reliable signal that OpenROAD finished:
 * output alone cannot distinguish "still working" from "done", and a quiet
 * period is not a completion signal for commands that think silently for
 * minutes (read_db, repair_timing, detailed route).
 *
 * The Tcl is written so the assembled marker never appears in the PTY's echo of
 * the input line -- `join` builds "ORMCP-DONE-<nonce>" at runtime, so a search
 * for that literal can only match real stdout, never the echoed source.
 */
const SENTINEL_MARKER = (nonce: string): string => `ORMCP-DONE-${nonce}`;
const SENTINEL_COMMAND = (nonce: string): string => `puts "[join {ORMCP DONE ${nonce}} -]"`;

/** Matches any sentinel, including a stale one left by a timed-out command. */
const ANY_SENTINEL_LINE = /ORMCP[-\s]DONE[-\s][0-9a-z]+/i;

/** Pieces of a sentinel line, used to cut it out of a segment it shares with
 * real output without discarding that output. */
const SENTINEL_TOKEN_HEAD = /ORMCP[-\s]DONE[-\s]/i;
const SENTINEL_ECHO_PREFIX = 'puts "[join {';
const SENTINEL_ECHO_SUFFIX = '} -]"';
const STALE_NONCE = /^[0-9a-z]+/;

/**
 * Startup probe. Uses the same runtime-assembly trick as the sentinel for the
 * same reason: a probe whose token appears verbatim in its own source would be
 * satisfied by the PTY's echo, so a session that echoes every keystroke but
 * executes nothing -- precisely the failure this guards against -- would pass.
 */
const PROBE_COMMAND = `puts "[join {ORMCP READY OK} -]"`;
const PROBE_TOKEN = "ORMCP-READY-OK";

/** Liveness re-check cadence while blocked waiting for the sentinel. Bounded so
 * a process that dies without emitting output is noticed promptly rather than
 * at the full command timeout. */
const SENTINEL_POLL_MS = 200;

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
  // OpenROAD's native log format: [ERROR RSZ-0089] message. Must precede the
  // generic "Error:" rules — those look for a colon, so this form was being
  // returned as success with the failure sitting in the output text.
  [/\[ERROR\s+([A-Z]+-\d+)\]\s*([^\r\n]+)/, "OpenROAD {0}: {1}"],
  [/\[FATAL\s+([A-Z]+-\d+)\]\s*([^\r\n]+)/, "OpenROAD fatal {0}: {1}"],
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
  private _sentinelCounter = 0;
  private _writerTask: Promise<void> | null = null;
  // Serialises terminate()/cleanup() so concurrent callers cannot double-kill
  // the process or deliver a stale exit code to waiters.
  private readonly _lifecycleLock = new Mutex();

  /**
   * Recent command output, kept so it can be searched after the fact.
   *
   * runCommand drains the circular buffer to empty, so anything searching the
   * live buffer finds nothing once a command has returned. Retaining the
   * cleaned output here is what makes grep over a session's results possible
   * without re-running the command or re-sending a large result.
   */
  private readonly _outputHistory: SessionOutputRecord[] = [];
  private _outputHistoryChars = 0;
  /** Records dropped to stay inside the retention budget. */
  private _outputHistoryEvicted = 0;

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

    this._enqueueRaw(command);
    this.commandCount++;
    this.totalCommandsExecuted++;
    this.lastActivity = new Date();
  }

  /** Queue a line for the writer task without touching history or counters.
   * Used for the internal completion sentinel, which is bookkeeping rather
   * than a user command and must not appear in the audit trail. */
  private _enqueueRaw(command: string): void {
    // Every embedded newline is a line the editor has to accept, not just the
    // final one, so normalise all of them rather than only the terminator.
    const line = command.replace(/\r?\n/g, PTY_LINE_TERMINATOR).replace(/\r+$/, "");
    this._inputQueue.push(line + PTY_LINE_TERMINATOR);
    const waiters = this._inputWaiters.splice(0);
    for (const w of waiters) w();
  }

  /**
   * Prove the session can actually execute a command before it is handed out.
   *
   * A PTY-attached OpenROAD can come up healthy-looking -- process alive,
   * prompt printed -- while its line editor never accepts the lines we write,
   * so every command silently does nothing. Failing here turns that into an
   * immediate, obvious session-creation error instead of a run's worth of
   * results that were never computed.
   */
  async verifyResponsive(timeoutMs = 15000): Promise<void> {
    const result = await this.runCommand(PROBE_COMMAND, timeoutMs, false);
    if (!result.output.includes(PROBE_TOKEN)) {
      throw new SessionError(
        `Session ${this.sessionId} started but is not executing commands: the OpenROAD ` +
          `process is alive yet never ran a probe command within ${timeoutMs}ms. This usually ` +
          `means its interactive line editor is not accepting input. ` +
          `Probe error: ${result.error ?? "none"}. ` +
          `Probe returned: ${JSON.stringify(result.output.slice(-200))}`,
        this.sessionId,
      );
    }
    // The probe is plumbing, not user activity; keep it out of the audit trail.
    this.commandHistory.length = 0;
    this.commandCount = 0;
    this.totalCommandsExecuted = 0;
  }

  /**
   * Send a command and read until it actually completes.
   *
   * Prefer this over sendCommand + readOutput: readOutput cannot tell a
   * finished command from one that has merely gone quiet, so it returns the
   * PTY's echo as a successful result for anything slower than a few
   * milliseconds. This waits for an explicit sentinel and reports a real error
   * when the command does not finish inside timeoutMs.
   *
   * `retain` exists for the startup probe, which is plumbing rather than user
   * activity: its output must not be searchable and must not consume any of
   * the retention budget.
   */
  async runCommand(
    command: string,
    timeoutMs = 30000,
    retain = true,
  ): Promise<InteractiveExecResult> {
    const startTime = Date.now();

    if (!this.checkAlive()) {
      return this._drainTerminatedSession(startTime);
    }

    const nonce = `${Date.now().toString(36)}${(this._sentinelCounter++).toString(36)}${Math.floor(
      Math.random() * 0xffffff,
    ).toString(36)}`;
    const marker = SENTINEL_MARKER(nonce);

    // Zero the buffer's discard counter so the result accounts for this
    // command's loss only, not a previous command's.
    await this.outputBuffer.takeDiscarded();

    await this.sendCommand(command);
    this._enqueueRaw(SENTINEL_COMMAND(nonce));

    const { text, timedOut, died, discarded } = await this._readUntilMarker(
      marker,
      startTime,
      timeoutMs,
    );

    // Output is lost in two places -- evicted from the buffer before we drained
    // it, and sliced off the read accumulator once it passed the cap -- so both
    // have to be summed for the total to be honest.
    const bytesDiscarded = discarded + (await this.outputBuffer.takeDiscarded());
    const totalBytes = text.length + bytesDiscarded;

    const executionTime = (Date.now() - startTime) / 1000;
    const output = this._withTruncationNotice(
      ANSIDecoder.cleanOpenroadOutput(this._stripSentinelLines(text, nonce)),
      bytesDiscarded,
      totalBytes,
      text.length,
    );

    await this._updatePerformanceMetrics();
    this._recordReadResult(output.length, executionTime);
    if (retain) this._retainOutput(command, output);

    // An incomplete result outranks anything matched inside it: a command that
    // printed "Error:" and then kept running must not look like it finished.
    let error: string | null;
    if (timedOut) {
      error = `CommandTimeout: command did not complete within ${timeoutMs}ms`;
    } else if (died) {
      error = "SessionTerminated: process exited before the command completed";
    } else {
      // Only the retained tail is inspected, so an error printed in the
      // discarded head cannot be reported here. The truncation notice
      // prepended to `output` is what warns the caller of that blind spot.
      error = this._detectErrors(output) ?? null;
    }

    return {
      output,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      executionTime,
      commandCount: this.commandCount,
      bufferSize: this.outputBuffer.maxSize,
      truncated: bytesDiscarded > 0,
      bytesDiscarded,
      totalBytes,
      error,
    };
  }

  /**
   * Prepend the truncation banner when output was lost, and leave complete
   * output byte-for-byte untouched.
   */
  private _withTruncationNotice(
    output: string,
    bytesDiscarded: number,
    totalBytes: number,
    retained: number,
  ): string {
    if (bytesDiscarded <= 0) return output;
    return truncationNotice(bytesDiscarded, totalBytes, retained) + output;
  }

  /**
   * Accumulate output until the sentinel arrives, the deadline passes, or the
   * process dies. Accumulation is capped at the buffer's configured size,
   * keeping the tail, so a verbose multi-megabyte command cannot grow the heap
   * without bound. The sentinel is last, so trimming the front never loses it.
   */
  private async _readUntilMarker(
    marker: string,
    startTime: number,
    timeoutMs: number,
  ): Promise<{ text: string; timedOut: boolean; died: boolean; discarded: number }> {
    const cap = Math.max(this.outputBuffer.maxSize, 1);
    let text = "";
    let discarded = 0;

    const absorb = (chunks: string[]): void => {
      if (chunks.length === 0) return;
      text += chunks.join("");
      if (text.length > cap) {
        discarded += text.length - cap;
        text = text.slice(text.length - cap);
      }
    };

    for (;;) {
      absorb(await this.outputBuffer.drainAll());
      if (text.includes(marker)) return { text, timedOut: false, died: false, discarded };

      if (!this.checkAlive()) {
        absorb(await this.outputBuffer.drainAll());
        return { text, timedOut: false, died: !text.includes(marker), discarded };
      }

      const remaining = timeoutMs - (Date.now() - startTime);
      if (remaining <= 0) return { text, timedOut: true, died: false, discarded };

      // Capped so process death (which appends nothing) is still noticed.
      await this.outputBuffer.waitForData(Math.min(remaining, SENTINEL_POLL_MS));
    }
  }

  /** Remove sentinel echo and marker lines so callers never see the plumbing.
   * Matches any sentinel, not just the current one, so a marker left behind by
   * a previously timed-out command cannot leak into a later result. */
  private _stripSentinelLines(text: string, nonce?: string): string {
    if (!ANY_SENTINEL_LINE.test(text)) return text;
    // Terminals delimit with CR, LF or CRLF, and a line editor emits bare CRs
    // when it redraws. Splitting on LF alone would leave the sentinel sharing a
    // segment with real output and discard both.
    //
    // The sentinel is typed ahead while the user command runs, so its echo can
    // be interleaved with that command's output. Only the sentinel text is cut
    // from a segment; whatever else shares the segment is real output and kept.
    const echoTail = nonce === undefined ? undefined : `${nonce}${SENTINEL_ECHO_SUFFIX}`;
    return text
      .split(/\r\n|[\r\n]/)
      .flatMap((line) => {
        if (!ANY_SENTINEL_LINE.test(line)) {
          return echoTail !== undefined && this._isSentinelEchoTail(line, echoTail) ? [] : [line];
        }
        const remainder = this._removeSentinelText(line, nonce);
        return remainder.trim() === "" ? [] : [remainder];
      })
      .join("\n");
  }

  /** Cut every sentinel token, plus the echoed Tcl around it, out of a line. */
  private _removeSentinelText(line: string, nonce: string | undefined): string {
    let result = line;
    for (;;) {
      const match = SENTINEL_TOKEN_HEAD.exec(result);
      if (!match) return result;
      let start = match.index;
      if (result.slice(start - SENTINEL_ECHO_PREFIX.length, start) === SENTINEL_ECHO_PREFIX) {
        start -= SENTINEL_ECHO_PREFIX.length;
      }
      const isEcho = !match[0].includes("-");
      const end = this._sentinelTokenEnd(result, match.index + match[0].length, nonce, isEcho);
      result = result.slice(0, start) + result.slice(end);
    }
  }

  /**
   * Find where a sentinel token's nonce (and echoed closing syntax) ends.
   * With the current nonce known, only the characters that actually belong to
   * it are consumed, so output interleaved right after a truncated echo stays.
   */
  private _sentinelTokenEnd(
    line: string,
    nonceStart: number,
    nonce: string | undefined,
    isEcho: boolean,
  ): number {
    const wholeTokenEnd = nonceStart + (STALE_NONCE.exec(line.slice(nonceStart))?.[0].length ?? 0);
    const isWholeToken = isEcho
      ? line.startsWith(SENTINEL_ECHO_SUFFIX, wholeTokenEnd)
      : wholeTokenEnd === line.length || /\s/.test(line[wholeTokenEnd] ?? "");
    let end = wholeTokenEnd;
    if (!isWholeToken && nonce !== undefined) {
      end = nonceStart;
      while (end - nonceStart < nonce.length && line[end] === nonce[end - nonceStart]) end++;
    }
    return line.startsWith(SENTINEL_ECHO_SUFFIX, end) ? end + SENTINEL_ECHO_SUFFIX.length : end;
  }

  /** True for the tail of a sentinel echo split off by interleaved output. */
  private _isSentinelEchoTail(line: string, echoTail: string): boolean {
    const fragment = line.trim();
    return fragment.length > SENTINEL_ECHO_SUFFIX.length && echoTail.endsWith(fragment);
  }

  /** Shared drain-before-reject path for a session that is already dead. */
  private async _drainTerminatedSession(startTime: number): Promise<InteractiveExecResult> {
    this._signalShutdown();
    const chunks = await this.outputBuffer.drainAll();
    if (chunks.length === 0) {
      throw new SessionTerminatedError(`Session ${this.sessionId} is not active`, this.sessionId);
    }
    const raw = chunks.join("");
    const bytesDiscarded = await this.outputBuffer.takeDiscarded();
    const totalBytes = raw.length + bytesDiscarded;
    const output = this._withTruncationNotice(
      ANSIDecoder.cleanOpenroadOutput(this._stripSentinelLines(raw)),
      bytesDiscarded,
      totalBytes,
      raw.length,
    );
    const executionTime = (Date.now() - startTime) / 1000;
    this._recordReadResult(output.length, executionTime);
    return {
      output,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      executionTime,
      commandCount: this.commandCount,
      bufferSize: this.outputBuffer.maxSize,
      truncated: bytesDiscarded > 0,
      bytesDiscarded,
      totalBytes,
      error: this._detectErrors(output) ?? null,
    };
  }

  /**
   * Drain whatever output has arrived, using a quiet period as a stop signal.
   *
   * This cannot detect command completion -- a command that thinks silently
   * for longer than MAX_COMMAND_COMPLETION_WINDOW returns here as an empty
   * success. Use runCommand() for anything that needs to know the command
   * actually finished; this remains for callers that just want to sample the
   * buffer.
   */
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
      return this._drainTerminatedSession(startTime);
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
    const bytesDiscarded = await this.outputBuffer.takeDiscarded();
    const totalBytes = rawOutput.length + bytesDiscarded;
    const executionTime = (Date.now() - startTime) / 1000;
    const output = this._withTruncationNotice(
      ANSIDecoder.cleanOpenroadOutput(rawOutput),
      bytesDiscarded,
      totalBytes,
      rawOutput.length,
    );

    await this._updatePerformanceMetrics();
    this._recordReadResult(output.length, executionTime);

    return {
      output,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      executionTime,
      commandCount: this.commandCount,
      bufferSize: this.outputBuffer.maxSize,
      truncated: bytesDiscarded > 0,
      bytesDiscarded,
      totalBytes,
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
      // Always present so the wire shape matches Python's model_dump, which
      // emits error:null for every BaseResult. Omitting it here would drop
      // the key from the serialized session info (and from list entries).
      error: null,
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
        // Function replacement so `$&`/`$1`/`$$` inside the captured error text
        // are inserted literally, not reinterpreted as replacement patterns.
        return template
          .replace("{0}", () => (match[1] ?? "").trim())
          .replace("{1}", () => (match[2] ?? "").trim());
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

  /** Keep a command's output for later searching, oldest evicted first. */
  private _retainOutput(command: string, output: string): void {
    if (output.length === 0) return;

    const maxChars = this._settings.OUTPUT_HISTORY_CHARS ?? OUTPUT_HISTORY_DEFAULTS.MAX_CHARS;
    const maxCommands =
      this._settings.OUTPUT_HISTORY_COMMANDS ?? OUTPUT_HISTORY_DEFAULTS.MAX_COMMANDS;
    if (maxChars <= 0 || maxCommands <= 0) return;

    // A single result larger than the whole budget keeps its tail, matching
    // how the output buffer itself sheds the head.
    const kept = output.length > maxChars ? output.slice(output.length - maxChars) : output;

    this._outputHistory.push({
      commandNumber: this.commandCount,
      command,
      timestamp: new Date().toISOString(),
      output: kept,
      truncated: kept.length < output.length,
    });
    this._outputHistoryChars += kept.length;

    while (
      this._outputHistory.length > maxCommands ||
      (this._outputHistoryChars > maxChars && this._outputHistory.length > 1)
    ) {
      const dropped = this._outputHistory.shift()!;
      this._outputHistoryChars -= dropped.output.length;
      this._outputHistoryEvicted += 1;
    }
  }

  /**
   * Search retained command output, plus anything still sitting unread in the
   * live buffer.
   *
   * `pattern` is treated as a regular expression, falling back to a substring
   * search when it does not compile, so a caller passing a bare net name is
   * never met with a syntax error.
   */
  async grepOutput(
    pattern: string,
    opts: { maxMatches?: number; contextLines?: number; ignoreCase?: boolean; commandNumber?: number } = {},
  ): Promise<SessionGrepResult> {
    const maxMatches = opts.maxMatches ?? 200;
    const contextLines = Math.max(0, opts.contextLines ?? 0);
    const ignoreCase = opts.ignoreCase ?? true;

    const substringTest = (line: string): boolean => {
      const needle = ignoreCase ? pattern.toLowerCase() : pattern;
      return (ignoreCase ? line.toLowerCase() : line).includes(needle);
    };

    let test: (line: string) => boolean;
    let patternKind: SessionGrepResult["patternKind"];
    try {
      const regex = new RegExp(pattern, ignoreCase ? "i" : "");
      test = (line: string): boolean => regex.test(line);
      patternKind = "regex";
    } catch {
      // An uncompilable pattern is a literal, not a user error.
      test = substringTest;
      patternKind = "substring";
    }

    const sources: SessionOutputRecord[] = this._outputHistory.filter(
      (r) => opts.commandNumber === undefined || r.commandNumber === opts.commandNumber,
    );
    if (opts.commandNumber === undefined) {
      // Output that has arrived but not yet been consumed by a command.
      const pending = this.outputBuffer.toText(await this.outputBuffer.peekAll());
      if (pending.length > 0) {
        sources.push({
          commandNumber: this.commandCount + 1,
          command: "(unread buffer)",
          timestamp: new Date().toISOString(),
          output: pending,
          truncated: false,
        });
      }
    }

    const search = (
      predicate: (line: string) => boolean,
    ): { matches: SessionGrepMatch[]; totalMatches: number; searchedLines: number } => {
      const found: SessionGrepMatch[] = [];
      let total = 0;
      let scanned = 0;
      for (const record of sources) {
        const lines = record.output.split("\n");
        scanned += lines.length;
        for (let i = 0; i < lines.length; i += 1) {
          if (!predicate(lines[i]!)) continue;
          total += 1;
          if (found.length >= maxMatches) continue;
          found.push({
            commandNumber: record.commandNumber,
            command: record.command,
            lineNumber: i + 1,
            line: lines[i]!,
            ...(contextLines > 0 && {
              before: lines.slice(Math.max(0, i - contextLines), i),
              after: lines.slice(i + 1, i + 1 + contextLines),
            }),
          });
        }
      }
      return { matches: found, totalMatches: total, searchedLines: scanned };
    };

    let { matches, totalMatches, searchedLines } = search(test);

    // A pasted instance or net name like `dpath.a_reg[0]` is *valid* regex that
    // matches nothing, which is worse than a syntax error: the caller is told
    // there are no matches when it is the pattern that is wrong. Retry such a
    // pattern literally and say that is what happened.
    if (totalMatches === 0 && patternKind === "regex" && /[[\](){}.*+?^$|\\]/.test(pattern)) {
      const literal = search(substringTest);
      if (literal.totalMatches > 0) {
        ({ matches, totalMatches, searchedLines } = literal);
        patternKind = "substring-fallback";
      }
    }

    return {
      matches,
      totalMatches,
      // Say plainly when matches were dropped, rather than returning a capped
      // list that reads like the whole answer.
      truncated: totalMatches > matches.length,
      patternKind,
      searchedCommands: sources.length,
      searchedLines,
      retainedChars: this._outputHistoryChars,
      evictedCommands: this._outputHistoryEvicted,
    };
  }

  /** Matching lines only. Retained for callers that just want the text. */
  async filterOutput(pattern: string, maxLines = 1000): Promise<string[]> {
    const result = await this.grepOutput(pattern, { maxMatches: maxLines });
    return result.matches.map((m) => m.line);
  }
}
