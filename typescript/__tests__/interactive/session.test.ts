import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InteractiveSession } from "../../src/interactive/session.js";
import { SessionState } from "../../src/core/models.js";
import { SessionError, SessionTerminatedError } from "../../src/interactive/models.js";
import { Settings } from "../../src/config/settings.js";
import { MAX_COMMAND_HISTORY } from "../../src/constants.js";
import type { PtyHandler } from "../../src/interactive/pty_handler.js";

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

function makeMockPty() {
  return {
    isProcessAlive: vi.fn().mockReturnValue(true),
    createSession: vi.fn().mockResolvedValue(undefined),
    writeInput: vi.fn(),
    terminateProcess: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    waitForExit: vi.fn().mockResolvedValue(null),
    validateCommand: vi.fn(),
  } as unknown as PtyHandler;
}

describe("InteractiveSession", () => {
  let session: InteractiveSession;
  let mockPty: PtyHandler;

  beforeEach(() => {
    session = new InteractiveSession("test-session-1", 1024);
    mockPty = makeMockPty();
    session.pty = mockPty;
  });

  afterEach(async () => {
    await session.cleanup();
    vi.clearAllMocks();
  });

  describe("creation", () => {
    it("sets correct initial state", () => {
      expect(session.sessionId).toBe("test-session-1");
      expect(session.state).toBe(SessionState.CREATING);
      expect(session.commandCount).toBe(0);
      expect(session.checkAlive()).toBe(false);
      expect(session.pty).not.toBeNull();
      expect(session.outputBuffer).not.toBeNull();
    });

    it("getInfo reflects initial state", async () => {
      const info = await session.getInfo();
      expect(info.sessionId).toBe("test-session-1");
      expect(info.state).toBe(SessionState.CREATING);
      expect(info.isAlive).toBe(false);
      expect(info.commandCount).toBe(0);
      expect(info.bufferSize).toBe(0);
      expect(typeof info.uptimeSeconds).toBe("number");
    });
  });

  describe("start", () => {
    it("transitions to ACTIVE and starts the writer task", async () => {
      await session.start(["echo", "test"]);

      expect(session.state).toBe(SessionState.ACTIVE);
      expect(mockPty.createSession).toHaveBeenCalledWith(
        ["echo", "test"],
        undefined,
        undefined,
        expect.any(Function),
        expect.any(Function),
      );
      expect(session.isRunning()).toBe(true);

      await session.cleanup();
    });

    it("uses default openroad command when none provided", async () => {
      await session.start();

      expect(mockPty.createSession).toHaveBeenCalledWith(
        ["openroad", "-no_init"],
        undefined,
        undefined,
        expect.any(Function),
        expect.any(Function),
      );

      await session.cleanup();
    });

    it("passes env and cwd through to createSession", async () => {
      const env = { TEST_VAR: "value" };
      const cwd = "/test/dir";
      await session.start(["custom", "command"], env, cwd);

      expect(mockPty.createSession).toHaveBeenCalledWith(
        ["custom", "command"],
        env,
        cwd,
        expect.any(Function),
        expect.any(Function),
      );

      await session.cleanup();
    });

    it("transitions to ERROR and cleans up when createSession throws", async () => {
      (mockPty.createSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("PTY creation failed"),
      );

      await expect(session.start(["fail"])).rejects.toThrow("Failed to start session");
      expect(session.state).toBe(SessionState.ERROR);
    });
  });

  describe("sendCommand", () => {
    it("queues command and increments command count", async () => {
      session.state = SessionState.ACTIVE;
      (mockPty.isProcessAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);

      await session.sendCommand("test command");

      expect(session.commandCount).toBe(1);
      expect(session.inputQueueSize()).toBe(1);
    });

    it("terminates each command with a carriage return, normalising any trailing newline", async () => {
      await session.start(["openroad", "-no_init"]);
      (mockPty.isProcessAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);

      await session.sendCommand("test command");
      await session.sendCommand("with newline\n");
      expect(session.commandCount).toBe(2);

      // A line editor in raw mode accepts CR, not LF; sending LF can leave the
      // command unsubmitted in the edit buffer.
      await vi.waitFor(() => {
        expect(mockPty.writeInput).toHaveBeenCalledTimes(2);
      });
      const written = (mockPty.writeInput as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
      expect(written[0]).toBe("test command\r");
      expect(written[1]).toBe("with newline\r");
    });

    it("converts embedded newlines to carriage returns in a multi-line command", async () => {
      await session.start(["openroad", "-no_init"]);
      (mockPty.isProcessAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);

      // Each inner line has to be accepted by the editor too, so an LF left in
      // the middle would strand everything after it in the edit buffer.
      await session.sendCommand("set a 1\nset b 2");

      await vi.waitFor(() => {
        expect(mockPty.writeInput).toHaveBeenCalledTimes(1);
      });
      expect((mockPty.writeInput as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(
        "set a 1\rset b 2\r",
      );
    });

    it("throws SessionTerminatedError on terminated session", async () => {
      session.state = SessionState.TERMINATED;
      await expect(session.sendCommand("test")).rejects.toThrow(SessionTerminatedError);
    });

    it("throws SessionError when input queue is full", async () => {
      const smallQueueSession = new InteractiveSession(
        "small-queue",
        1024,
        new Settings({ SESSION_QUEUE_SIZE: 2 }),
      );
      smallQueueSession.pty = makeMockPty();
      smallQueueSession.state = SessionState.ACTIVE;

      await smallQueueSession.sendCommand("cmd1");
      await smallQueueSession.sendCommand("cmd2");

      await expect(smallQueueSession.sendCommand("cmd3")).rejects.toThrow(SessionError);
      await expect(smallQueueSession.sendCommand("cmd3")).rejects.toThrow("Input queue full");

      await smallQueueSession.cleanup();
    });

    it("does not increment commandCount when queue is full", async () => {
      const smallQueueSession = new InteractiveSession(
        "count-guard",
        1024,
        new Settings({ SESSION_QUEUE_SIZE: 2 }),
      );
      smallQueueSession.pty = makeMockPty();
      smallQueueSession.state = SessionState.ACTIVE;

      await smallQueueSession.sendCommand("cmd1");
      await smallQueueSession.sendCommand("cmd2");
      expect(smallQueueSession.commandCount).toBe(2);

      await expect(smallQueueSession.sendCommand("cmd3")).rejects.toThrow(SessionError);
      expect(smallQueueSession.commandCount).toBe(2);

      await smallQueueSession.cleanup();
    });

    it("increments command count with multiple commands", async () => {
      session.state = SessionState.ACTIVE;
      (mockPty.isProcessAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);

      await session.sendCommand("cmd1");
      await session.sendCommand("cmd2");

      expect(session.commandCount).toBe(2);
    });
  });

  describe("readOutput", () => {
    beforeEach(() => {
      session.state = SessionState.ACTIVE;
      (mockPty.isProcessAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);
    });

    it("returns output from buffer", async () => {
      await session.outputBuffer.append("test output");

      const result = await session.readOutput(100);

      expect(result.sessionId).toBe("test-session-1");
      expect(result.output).toContain("test output");
      expect(result.commandCount).toBe(0);
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });

    it("throws on terminated session with empty buffer", async () => {
      session.state = SessionState.TERMINATED;
      await expect(session.readOutput()).rejects.toThrow(SessionTerminatedError);
    });

    it("drains buffered output instead of throwing when session terminates before readOutput is called (fast-exit race)", async () => {
      // Simulate: sendCommand("exit\n") returns, onData fires and appends final
      // output, then onExit fires and flips state to TERMINATED, all before
      // the caller has a chance to call readOutput.
      await session.outputBuffer.append("% Exiting OpenROAD\r\n");
      session.state = SessionState.TERMINATED;

      const result = await session.readOutput(100);

      expect(result.output).toContain("Exiting OpenROAD");
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
      expect(session.outputBuffer.size).toBe(0);
    });

    it("signals shutdown when readOutput detects terminated session so writer task does not loop indefinitely", async () => {
      // Spy on the private method to verify readOutput() calls it directly.
      // Scenario: _state was flipped to TERMINATED externally (e.g. via the
      // setter) without calling _signalShutdown().
      const signalShutdown = vi.spyOn(session as unknown as { _signalShutdown: () => void }, "_signalShutdown");

      session.state = SessionState.TERMINATED;
      await session.outputBuffer.append("last output");

      await session.readOutput(100);

      expect(signalShutdown).toHaveBeenCalled();
    });

    it("throws SessionTerminatedError when session is terminated AND buffer is empty", async () => {
      session.state = SessionState.TERMINATED;
      await expect(session.readOutput()).rejects.toThrow(SessionTerminatedError);
    });

    it("collects delayed output within timeout", async () => {
      setTimeout(() => {
        void session.outputBuffer.append("delayed output");
      }, 20);

      const result = await session.readOutput(200);

      expect(result.output).toContain("delayed output");
      expect(result.executionTime).toBeGreaterThan(0);
    });

    it("cannot detect completion: returns the echo as success while the command is still running", async () => {
      // Characterisation test, not aspirational. readOutput stops after
      // MAX_COMMAND_COMPLETION_WINDOW of silence, so a command that echoes
      // immediately and then thinks for 400ms looks finished and successful.
      // This is why executeCommand routes through runCommand instead; if you
      // are tempted to use readOutput for a command, read this first.
      await session.outputBuffer.append("read_db /tmp/big.odb\r\n"); // PTY echo
      setTimeout(() => {
        void session.outputBuffer.append("real result arrives late\r\n");
      }, 400);

      const result = await session.readOutput(5000);

      expect(result.output).not.toContain("real result arrives late");
      expect(result.error).toBeNull();
      expect(result.executionTime).toBeLessThan(0.3);
    });
  });

  describe("runCommand (sentinel-based completion)", () => {
    const NONCE_RE = /join \{ORMCP DONE (\S+)\}/;

    /**
     * Drive the mock PTY like a real one: echo every written line back, then
     * after `thinkMs` of silence emit the command's output followed by the
     * sentinel. `thinkMs` is the whole point -- it reproduces a command that
     * stays quiet longer than the old 100ms completion window.
     */
    function wirePty(opts: {
      thinkMs: number;
      output: string;
      emitSentinel?: boolean;
      chunkSize?: number;
    }): void {
      const { thinkMs, output, emitSentinel = true, chunkSize } = opts;
      (mockPty.writeInput as ReturnType<typeof vi.fn>).mockImplementation((data: string) => {
        // A terminal echoes the submitted line back as CRLF.
        void session.outputBuffer.append(data.replace(/\r$/, "\r\n"));
        const match = NONCE_RE.exec(data);
        if (!match) return;
        const nonce = match[1]!;
        setTimeout(() => {
          if (chunkSize === undefined) {
            void session.outputBuffer.append(output);
          } else {
            // A real PTY delivers a long report in many small reads, not one
            // giant write; chunking reproduces the eviction pattern that
            // actually loses output in production.
            for (let i = 0; i < output.length; i += chunkSize) {
              void session.outputBuffer.append(output.slice(i, i + chunkSize));
            }
          }
          if (emitSentinel) void session.outputBuffer.append(`ORMCP-DONE-${nonce}\r\n`);
        }, thinkMs);
      });
    }

    beforeEach(async () => {
      await session.start(["openroad", "-no_init"]);
    });

    it("waits for a command that stays silent well past the 100ms completion window", async () => {
      // The regression that shipped: readOutput() saw the PTY echo, waited
      // MAX_COMMAND_COMPLETION_WINDOW (100ms), saw nothing more, and returned
      // the echo as a successful empty result while OpenROAD was still working.
      wirePty({ thinkMs: 400, output: "wns max -0.485\r\n" });

      const result = await session.runCommand("report_wns", 5000);

      expect(result.output).toContain("wns max -0.485");
      expect(result.error).toBeNull();
      expect(result.executionTime).toBeGreaterThan(0.3);
    });

    it("strips the sentinel echo and marker from the returned output", async () => {
      wirePty({ thinkMs: 10, output: "real output\r\n" });

      const result = await session.runCommand("report_wns", 2000);

      expect(result.output).toContain("real output");
      expect(result.output).not.toContain("ORMCP");
      expect(result.output).not.toContain("join {");
    });

    it("reports CommandTimeout instead of silent success when the command never finishes", async () => {
      wirePty({ thinkMs: 10, output: "partial work\r\n", emitSentinel: false });

      const result = await session.runCommand("repair_timing", 400);

      expect(result.error).toMatch(/CommandTimeout/);
      expect(result.output).toContain("partial work");
    });

    it("does not report success when the process dies mid-command", async () => {
      (mockPty.writeInput as ReturnType<typeof vi.fn>).mockImplementation((data: string) => {
        void session.outputBuffer.append(data.replace(/\r$/, "\r\n"));
        if (NONCE_RE.test(data)) {
          setTimeout(() => {
            (mockPty.isProcessAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);
          }, 50);
        }
      });

      const result = await session.runCommand("read_db /tmp/huge.odb", 3000);

      expect(result.error).toMatch(/SessionTerminated/);
    });

    it("keeps the sentinel out of the audit trail", async () => {
      wirePty({ thinkMs: 10, output: "ok\r\n" });

      await session.runCommand("report_tns", 2000);

      const history = session.getCommandHistory();
      expect(history).toHaveLength(1);
      expect(history[0]!.command).toBe("report_tns");
      expect(session.commandCount).toBe(1);
    });

    it("records a real per-command execution time rather than a fixed window", async () => {
      wirePty({ thinkMs: 350, output: "done\r\n" });

      await session.runCommand("place_design", 5000);

      const entry = session.getCommandHistory()[0]!;
      expect(entry.executionTime).toBeGreaterThan(0.3);
    });

    it("suppresses a stale marker left behind by an earlier timed-out command", async () => {
      await session.outputBuffer.append("ORMCP-DONE-staleabc123\r\n");
      wirePty({ thinkMs: 10, output: "fresh output\r\n" });

      const result = await session.runCommand("report_checks", 2000);

      expect(result.output).toContain("fresh output");
      expect(result.output).not.toContain("staleabc123");
    });

    it.each([
      ["uppercase output", "YYYYY"],
      ["lowercase output", "abc123"],
    ])(
      "keeps %s that interleaves with the typed-ahead sentinel echo",
      async (_label, commandOutput) => {
        (mockPty.writeInput as ReturnType<typeof vi.fn>).mockImplementation((data: string) => {
          const match = NONCE_RE.exec(data);
          if (!match) {
            void session.outputBuffer.append(data.replace(/\r$/, "\r\n"));
            return;
          }
          const nonce = match[1]!;
          const echo = data.replace(/\r$/, "");
          let split = echo.indexOf(nonce) + 3;
          while (echo[split] === commandOutput[0]) split++;
          void session.outputBuffer.append(
            `${echo.slice(0, split)}${commandOutput}\r\n${echo.slice(split)}\r\n`,
          );
          setTimeout(() => void session.outputBuffer.append(`ORMCP-DONE-${nonce}\r\n`), 10);
        });

        const result = await session.runCommand("puts [string repeat Y 5]", 2000);

        expect(result.error).toBeNull();
        expect(result.output).toBe(`puts [string repeat Y 5]\n${commandOutput}`);
      },
    );

    it("suppresses a stale echoed sentinel that shares the current nonce's timestamp prefix", async () => {
      wirePty({ thinkMs: 10, output: "fresh output\r\n" });
      const staleNonce = `${Date.now().toString(36)}0abc`;
      await session.outputBuffer.append(`puts "[join {ORMCP DONE ${staleNonce}} -]"\r\n`);

      const result = await session.runCommand("report_checks", 2000);

      expect(result.output).toContain("fresh output");
      expect(result.output).not.toContain("abc");
      expect(result.output).not.toContain("ORMCP");
    });

    it("verifyResponsive rejects a session whose line editor never accepts input", async () => {
      // The VM failure: the process is alive and echoes every submitted line
      // back cleanly, but never runs it. The echo alone must not satisfy the
      // probe, which is why the probe token is assembled at runtime.
      (mockPty.writeInput as ReturnType<typeof vi.fn>).mockImplementation((data: string) => {
        void session.outputBuffer.append(data.replace(/\r$/, "\r\n"));
      });

      await expect(session.verifyResponsive(600)).rejects.toThrow(/not executing commands/);
    });

    it("verifyResponsive accepts a healthy session without polluting the audit trail", async () => {
      wirePty({ thinkMs: 10, output: "ORMCP-READY-OK\r\n" });

      await session.verifyResponsive(2000);

      expect(session.getCommandHistory()).toHaveLength(0);
      expect(session.commandCount).toBe(0);
    });

    it("keeps the startup probe out of the searchable output history", async () => {
      wirePty({ thinkMs: 10, output: "ORMCP-READY-OK\r\n" });
      await session.verifyResponsive(2000);

      // The probe ran through runCommand, so its output was being retained and
      // charged to the retention budget like a user command.
      const probe = await session.grepOutput("ORMCP-READY-OK");
      expect(probe.totalMatches).toBe(0);
      expect(probe.retainedChars).toBe(0);

      // It also consumed command number 1 before verifyResponsive reset the
      // counter, so the caller's first real command collided with it.
      wirePty({ thinkMs: 10, output: "wns max -0.485\r\n" });
      await session.runCommand("report_checks", 2000);

      const grep = await session.grepOutput("wns max");
      expect(grep.searchedCommands).toBe(1);
      expect(grep.matches.map((m) => m.commandNumber)).toEqual([1]);
    });

    it("reports a timeout even when the partial output contains an error pattern", async () => {
      wirePty({ thinkMs: 10, output: "Error: something went wrong\r\n", emitSentinel: false });

      const result = await session.runCommand("long_running_thing", 400);

      // A truncated result must not be presented as a completed, failed one.
      expect(result.error).toMatch(/CommandTimeout/);
    });

    it("still surfaces OpenROAD errors detected in the output", async () => {
      wirePty({ thinkMs: 10, output: 'invalid command name "bogus_cmd"\r\n' });

      const result = await session.runCommand("bogus_cmd", 2000);

      expect(result.error).toContain("Invalid command");
    });

    describe("truncation reporting", () => {
      // The session under test is built with a 1024-character buffer.
      const CAP = 1024;

      it("reports a complete result as untruncated and leaves output untouched", async () => {
        wirePty({ thinkMs: 10, output: "wns max -0.485\r\n" });

        const result = await session.runCommand("report_wns", 2000);

        expect(result.truncated).toBe(false);
        expect(result.bytesDiscarded).toBe(0);
        expect(result.output).toContain("wns max -0.485");
        expect(result.output).not.toContain("TRUNCATED");
        expect(result.totalBytes).toBeGreaterThan(0);
      });

      it("reports buffer capacity rather than the always-zero residual", async () => {
        // The S3 bug: buffer_size reported outputBuffer.size, but a result is
        // only built after the buffer has been drained, so it was always 0 --
        // the one field that could have signalled truncation was inert.
        wirePty({ thinkMs: 10, output: "ok\r\n" });

        const result = await session.runCommand("report_wns", 2000);

        expect(result.bufferSize).toBe(CAP);
      });

      it("flags a result whose head was discarded and accounts for the loss", async () => {
        const huge = "x".repeat(5000) + "\r\n";
        wirePty({ thinkMs: 10, output: huge, chunkSize: 64 });

        const result = await session.runCommand("report_checks", 2000);

        expect(result.truncated).toBe(true);
        expect(result.bytesDiscarded).toBeGreaterThan(0);
        expect(result.totalBytes).toBeGreaterThanOrEqual(huge.length);
        // Everything the command produced is either returned or accounted for
        // as discarded, and what comes back never exceeds the cap.
        expect(result.totalBytes - result.bytesDiscarded).toBeLessThanOrEqual(CAP);
      });

      it("announces the truncation inside output, where a reader cannot miss it", async () => {
        wirePty({ thinkMs: 10, output: "x".repeat(5000) + "\r\n", chunkSize: 64 });

        const result = await session.runCommand("report_checks", 2000);

        expect(result.output.startsWith("[TRUNCATED:")).toBe(true);
        expect(result.output).toContain("discarded from the START");
        expect(result.output).toContain("may begin mid-line");
      });

      it("does not carry one command's discarded bytes into the next result", async () => {
        wirePty({ thinkMs: 10, output: "x".repeat(5000) + "\r\n", chunkSize: 64 });
        const truncatedResult = await session.runCommand("report_checks", 2000);
        expect(truncatedResult.truncated).toBe(true);

        wirePty({ thinkMs: 10, output: "wns max -0.485\r\n" });
        const cleanResult = await session.runCommand("report_wns", 2000);

        expect(cleanResult.truncated).toBe(false);
        expect(cleanResult.bytesDiscarded).toBe(0);
      });
    });
  });

  describe("checkAlive", () => {
    it("returns false in CREATING state", () => {
      expect(session.state).toBe(SessionState.CREATING);
      expect(session.checkAlive()).toBe(false);
    });

    it("returns false in ACTIVE state when process is dead", () => {
      session.state = SessionState.ACTIVE;
      (mockPty.isProcessAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);

      expect(session.checkAlive()).toBe(false);
      expect(session.state).toBe(SessionState.TERMINATED);
    });

    it("calls _signalShutdown when process death is detected so writer task stops", async () => {
      await session.start(["echo"]);
      expect(session.isRunning()).toBe(true);

      (mockPty.isProcessAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);

      // getInfo() is the read-only health-check path described in the bug report
      await session.getInfo();

      expect(session.state).toBe(SessionState.TERMINATED);
      expect(session.isRunning()).toBe(false);
    });

    it("returns true in ACTIVE state with live process", () => {
      session.state = SessionState.ACTIVE;
      (mockPty.isProcessAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);

      expect(session.checkAlive()).toBe(true);
      expect(session.state).toBe(SessionState.ACTIVE);
    });

    it("returns false in TERMINATED state", () => {
      session.state = SessionState.TERMINATED;
      expect(session.checkAlive()).toBe(false);
    });
  });

  describe("terminate", () => {
    it("sets state to TERMINATED and calls pty.terminateProcess then pty.cleanup", async () => {
      session.state = SessionState.ACTIVE;

      await session.terminate(false);

      expect(session.state).toBe(SessionState.TERMINATED);
      expect(mockPty.terminateProcess).toHaveBeenCalledWith(false);
      expect(mockPty.cleanup).toHaveBeenCalledOnce();
    });

    it("passes force=true through to pty.terminateProcess", async () => {
      session.state = SessionState.ACTIVE;

      await session.terminate(true);

      expect(mockPty.terminateProcess).toHaveBeenCalledWith(true);
      expect(mockPty.cleanup).toHaveBeenCalledOnce();
    });

    it("is a no-op when already terminated", async () => {
      session.state = SessionState.TERMINATED;
      await session.terminate();
      expect(mockPty.terminateProcess).not.toHaveBeenCalled();
      expect(mockPty.cleanup).not.toHaveBeenCalled();
    });

    it("calls pty.cleanup() so listeners and pending resolvers are disposed without a subsequent session.cleanup()", async () => {
      session.state = SessionState.ACTIVE;

      await session.terminate(false);

      // pty.cleanup() must run to dispose _dataDisposable, _exitDisposable,
      // and drain _exitResolvers; otherwise post-kill data bursts keep
      // appending and waitForExit() callers hang forever.
      expect(mockPty.cleanup).toHaveBeenCalledOnce();
    });
  });

  describe("cleanup", () => {
    it("sets state to TERMINATED, clears buffer, calls pty.cleanup", async () => {
      session.state = SessionState.ACTIVE;
      await session.outputBuffer.append("test data");
      expect(session.outputBuffer.size).toBeGreaterThan(0);

      await session.cleanup();

      expect(session.state).toBe(SessionState.TERMINATED);
      expect(mockPty.cleanup).toHaveBeenCalledOnce();
      expect(session.outputBuffer.size).toBe(0);
    });
  });

  describe("full lifecycle", () => {
    it("CREATING -> start -> ACTIVE -> sendCommand -> terminate -> TERMINATED", async () => {
      expect(session.state).toBe(SessionState.CREATING);

      await session.start(["echo", "hello"]);
      expect(session.state).toBe(SessionState.ACTIVE);

      await session.sendCommand("test");
      expect(session.commandCount).toBe(1);

      await session.terminate();
      expect(session.state).toBe(SessionState.TERMINATED);
    });

    it("concurrent sendCommand calls all increment command count", async () => {
      await session.start();

      const tasks = Array.from({ length: 5 }, (_, i) => session.sendCommand(`command_${i}`));
      await Promise.all(tasks);

      expect(session.commandCount).toBe(5);

      await session.cleanup();
    });
  });

  describe("callback wiring (onData / onExit)", () => {
    let capturedOnData: ((data: string) => void) | undefined;
    let capturedOnExit: ((exitCode: number) => void) | undefined;

    beforeEach(() => {
      capturedOnData = undefined;
      capturedOnExit = undefined;
      (mockPty.createSession as ReturnType<typeof vi.fn>).mockImplementation(
        async (
          _cmd: unknown,
          _env: unknown,
          _cwd: unknown,
          onData: (d: string) => void,
          onExit: (c: number) => void,
        ) => {
          capturedOnData = onData;
          capturedOnExit = onExit;
        },
      );
    });

    it("onData callback routes data directly into outputBuffer", async () => {
      await session.start(["echo"]);

      capturedOnData?.("hello from pty\r\n");

      const chunks = await session.outputBuffer.drainAll();
      expect(chunks.join("")).toContain("hello from pty");
    });

    it("onExit callback transitions session state to TERMINATED", async () => {
      await session.start(["echo"]);
      expect(session.state).toBe(SessionState.ACTIVE);

      capturedOnExit?.(0);

      expect(session.state).toBe(SessionState.TERMINATED);
    });

    it("onExit callback is a no-op when session is already TERMINATED", async () => {
      await session.start(["echo"]);
      session.state = SessionState.TERMINATED;

      capturedOnExit?.(0);
      expect(session.state).toBe(SessionState.TERMINATED);
    });

    it("transitions to TERMINATED and signals shutdown when append() rejects in onData handler", async () => {
      await session.start(["echo"]);
      expect(session.state).toBe(SessionState.ACTIVE);

      vi.spyOn(session.outputBuffer, "append").mockRejectedValue(new Error("mutex corrupted"));

      capturedOnData?.("burst");

      // Give the rejected promise's .catch() a tick to run
      await new Promise<void>((r) => setTimeout(r, 5));

      expect(session.state).toBe(SessionState.TERMINATED);
      expect(session.checkAlive()).toBe(false);
    });

    it("onData data exactly at READ_CHUNK_SIZE is a single append, not sliced", async () => {
      const exactChunkSession = new InteractiveSession(
        "exact-chunk",
        1024 * 1024,
        new Settings({ READ_CHUNK_SIZE: 8, ENABLE_COMMAND_VALIDATION: false }),
      );
      const exactMock = makeMockPty();
      exactChunkSession.pty = exactMock;

      let capturedOnData: ((data: string) => void) | undefined;
      (exactMock.createSession as ReturnType<typeof vi.fn>).mockImplementation(
        async (_cmd: unknown, _env: unknown, _cwd: unknown, onData: (d: string) => void) => {
          capturedOnData = onData;
        },
      );

      await exactChunkSession.start(["openroad"]);

      // Exactly READ_CHUNK_SIZE chars - must take the `<=` branch: single append
      const exact = "12345678"; // exactly 8 chars
      capturedOnData?.(exact);

      await new Promise<void>((r) => setTimeout(r, 5));

      expect(exactChunkSession.outputBuffer.chunkCount).toBe(1);
      const chunks = await exactChunkSession.outputBuffer.drainAll();
      expect(chunks[0]).toBe(exact);

      await exactChunkSession.cleanup();
    });

    it("large onData burst is sliced into READ_CHUNK_SIZE chunks before buffering", async () => {
      // Use a small READ_CHUNK_SIZE so the test doesn't need megabytes of data
      const smallChunkSession = new InteractiveSession(
        "chunk-test",
        1024 * 1024, // large buffer so nothing is evicted
        new Settings({ READ_CHUNK_SIZE: 8, ENABLE_COMMAND_VALIDATION: false }),
      );
      const smallChunkMock = makeMockPty();
      smallChunkSession.pty = smallChunkMock;

      let capturedSmallOnData: ((data: string) => void) | undefined;
      (smallChunkMock.createSession as ReturnType<typeof vi.fn>).mockImplementation(
        async (
          _cmd: unknown,
          _env: unknown,
          _cwd: unknown,
          onData: (d: string) => void,
        ) => {
          capturedSmallOnData = onData;
        },
      );

      await smallChunkSession.start(["openroad"]);

      // Fire a 25-character burst - with chunkSize=8 this produces exactly 4 chunks
      // (8 + 8 + 8 + 1 = 25 chars across 4 append calls)
      const burst = "AAAAAAAABBBBBBBBCCCCCCCCD"; // 8+8+8+1 = 25 chars
      capturedSmallOnData?.(burst);

      // Give the async appends a tick to settle
      await new Promise<void>((r) => setTimeout(r, 5));

      expect(smallChunkSession.outputBuffer.chunkCount).toBe(4);
      const chunks = await smallChunkSession.outputBuffer.drainAll();
      expect(chunks.join("")).toBe(burst);
      expect(chunks[0]).toHaveLength(8);
      expect(chunks[1]).toHaveLength(8);
      expect(chunks[2]).toHaveLength(8);
      expect(chunks[3]).toHaveLength(1);

      await smallChunkSession.cleanup();
    });
  });

  describe("start() guard", () => {
    it("throws SessionError when called in ACTIVE state (not CREATING)", async () => {
      await session.start(["echo"]);
      expect(session.state).toBe(SessionState.ACTIVE);

      await expect(session.start(["echo"])).rejects.toThrow("Cannot start session in state");

      await session.cleanup();
    });
  });

  describe("_writeInput error handling", () => {
    it("transitions state to TERMINATED and signals shutdown when writeInput throws", async () => {
      (mockPty.writeInput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("PTY closed");
      });

      await session.start(["echo"]);
      expect(session.isRunning()).toBe(true);

      await session.sendCommand("trigger");

      // Give the writer loop a tick to process and hit the throw
      await new Promise<void>((r) => setTimeout(r, 20));

      expect(mockPty.writeInput).toHaveBeenCalled();
      expect(session.state).toBe(SessionState.TERMINATED);
      expect(session.checkAlive()).toBe(false);
    });

    it("subsequent sendCommand throws SessionTerminatedError after writer failure", async () => {
      (mockPty.writeInput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("PTY closed");
      });

      await session.start(["echo"]);
      await session.sendCommand("trigger");

      // Let the writer loop hit the throw and transition state
      await new Promise<void>((r) => setTimeout(r, 20));

      // State is TERMINATED - sendCommand must reject, not queue silently
      await expect(session.sendCommand("after-failure")).rejects.toThrow(SessionTerminatedError);
    });
  });

  describe("error detection in readOutput", () => {
    beforeEach(() => {
      session.state = SessionState.ACTIVE;
      (mockPty.isProcessAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);
    });

    it("detects OpenROAD Error: pattern in output", async () => {
      await session.outputBuffer.append('Error: design top not found\n');
      const result = await session.readOutput(100);
      // _detectErrors normalises to "Design not found: <name>"
      expect(result.error).toMatch(/Design not found: top/);
    });

    it("detects FATAL: pattern in output", async () => {
      await session.outputBuffer.append("FATAL: segmentation fault\n");
      const result = await session.readOutput(100);
      expect(result.error).toMatch(/Fatal error/);
    });

    it("detects OpenROAD [ERROR CODE-NNNN] lines, which have no colon", async () => {
      // The dry-run failure: repair_timing printed [ERROR RSZ-0089] and the
      // tool still returned error: null because only "Error:" / "ERROR:" were
      // recognised. Warnings must stay non-errors.
      await session.outputBuffer.append(
        "[WARNING EST-0027] no estimated parasitics. Using wire load models.\n" +
          "[ERROR RSZ-0089] Could not find a resistance value for any corner. Cannot evaluate max wire length for buffer.\n",
      );
      const result = await session.readOutput(100);
      expect(result.error).toMatch(/OpenROAD RSZ-0089/);
      expect(result.error).toMatch(/resistance value/);
    });

    it("does not treat an OpenROAD [WARNING] line as a command failure", async () => {
      await session.outputBuffer.append(
        "[WARNING EST-0027] no estimated parasitics. Using wire load models.\n",
      );
      const result = await session.readOutput(100);
      expect(result.error).toBeNull();
    });

    it("detects invalid command name pattern", async () => {
      await session.outputBuffer.append('invalid command name "foo_bar"\n');
      const result = await session.readOutput(100);
      expect(result.error).toMatch(/Invalid command/);
    });

    it("inserts captured text literally even when it contains $& replacement patterns", async () => {
      await session.outputBuffer.append('invalid command name "foo$&bar"\n');
      const result = await session.readOutput(100);
      expect(result.error).toBe("Invalid command: foo$&bar");
    });

    it("returns null error for clean output", async () => {
      await session.outputBuffer.append("openroad> \n");
      const result = await session.readOutput(100);
      expect(result.error).toBeNull();
    });

    it("detects error pattern through ANSI escape codes (strips before matching)", async () => {
      // ANSI codes wrapping the error text - must strip before regex matching
      await session.outputBuffer.append("\x1b[31mError: design top not found\x1b[0m\n");
      const result = await session.readOutput(100);
      expect(result.error).toMatch(/Design not found: top/);
    });
  });

  describe("activity, history, and metrics", () => {
    beforeEach(async () => {
      (mockPty.isProcessAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);
      await session.start();
    });

    it("updates lastActivity and grows history on sendCommand", async () => {
      const before = session.lastActivity.getTime();
      await session.sendCommand("report_wns");

      expect(session.commandHistory).toHaveLength(1);
      expect(session.commandHistory[0]!.command).toBe("report_wns");
      expect(session.commandHistory[0]!.commandNumber).toBe(1);
      expect(typeof session.commandHistory[0]!.executionStart).toBe("number");
      expect(session.totalCommandsExecuted).toBe(1);
      expect(session.lastActivity.getTime()).toBeGreaterThanOrEqual(before);
    });

    it("trims the recorded command text", async () => {
      await session.sendCommand("  puts hi  ");
      expect(session.commandHistory[0]!.command).toBe("puts hi");
    });

    it("records execution_time for every command batched into one readOutput", async () => {
      await session.sendCommand("cmd_a");
      await session.sendCommand("cmd_b");
      await session.readOutput(50);

      expect(session.commandHistory[0]!.executionTime).toBeDefined();
      expect(session.commandHistory[1]!.executionTime).toBeDefined();
    });

    it("bounds commandHistory at MAX_COMMAND_HISTORY, dropping the oldest", async () => {
      // Large queue so rapid sends never hit the input-queue-full guard.
      const s = new InteractiveSession("hist-cap", 1024, new Settings({ SESSION_QUEUE_SIZE: 1_000_000 }));
      s.pty = makeMockPty();
      await s.start();

      const total = MAX_COMMAND_HISTORY + 5;
      for (let i = 1; i <= total; i++) await s.sendCommand(`c${i}`);

      expect(s.commandHistory).toHaveLength(MAX_COMMAND_HISTORY);
      // Oldest entries dropped: first retained command_number is total - MAX + 1.
      expect(s.commandHistory[0]!.commandNumber).toBe(total - MAX_COMMAND_HISTORY + 1);
      await s.cleanup();
    });

    it("getCommandHistory filters by search (case-insensitive)", async () => {
      await session.sendCommand("report_wns");
      await session.sendCommand("get_nets foo");

      const filtered = session.getCommandHistory(undefined, "REPORT");
      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.command).toBe("report_wns");
    });

    it("getCommandHistory applies a limit and sorts most-recent-first", async () => {
      await session.sendCommand("cmd_a");
      await session.sendCommand("cmd_b");
      // Pin timestamps so the sort is deterministic regardless of wall-clock resolution.
      session.commandHistory[0]!.timestamp = "2024-01-01T00:00:00.000Z";
      session.commandHistory[1]!.timestamp = "2024-01-01T00:00:01.000Z";

      const limited = session.getCommandHistory(1);
      expect(limited).toHaveLength(1);
      expect(limited[0]!.command).toBe("cmd_b");
    });

    it("getCommandHistory ignores a negative limit instead of dropping entries", async () => {
      await session.sendCommand("cmd_a");
      await session.sendCommand("cmd_b");
      const all = session.getCommandHistory(-1);
      expect(all).toHaveLength(2);
    });

    it("getDetailedMetrics returns the full nested shape", async () => {
      await session.sendCommand("report_wns");
      const m = await session.getDetailedMetrics();

      expect(m.sessionId).toBe("test-session-1");
      expect(m.isAlive).toBe(true);
      expect(m.commands.totalExecuted).toBe(1);
      expect(m.commands.historyLength).toBe(1);
      expect(m.buffer.maxSize).toBe(1024);
      expect(m.timeout.configuredSeconds).toBeNull();
      expect(m.timeout.isTimedOut).toBe(false);
    });

    it("isIdleTimeout is false right after activity, true past the threshold", async () => {
      await session.sendCommand("report_wns");
      expect(session.isIdleTimeout(1000)).toBe(false);

      session.lastActivity = new Date(Date.now() - 10_000);
      expect(session.isIdleTimeout(1)).toBe(true);
    });

    it("setSessionTimeout drives the uptime-based is_timed_out flag", async () => {
      // is_timed_out compares configured timeout against wall-clock uptime
      // (distinct from idle timeout). Push createdAt into the past so uptime
      // deterministically exceeds the configured 1s timeout.
      session.setSessionTimeout(1);
      expect(session.sessionTimeoutSeconds).toBe(1);
      session.createdAt.setTime(Date.now() - 10_000);

      const m = await session.getDetailedMetrics();
      expect(m.timeout.configuredSeconds).toBe(1);
      expect(m.timeout.isTimedOut).toBe(true);
    });

    it("readOutput backfills execution_time and output_length on the last entry", async () => {
      await session.sendCommand("report_wns");
      await session.outputBuffer.append("wns 0.1\n");
      await session.readOutput(100);

      const entry = session.commandHistory[0]!;
      expect(entry.executionTime).toBeGreaterThanOrEqual(0);
      expect(entry.outputLength).toBeGreaterThan(0);
    });

    it("filterOutput returns matching lines (regex, case-insensitive)", async () => {
      await session.outputBuffer.append("alpha\nbeta\ngamma beta\n");
      const matches = await session.filterOutput("BETA");
      expect(matches).toEqual(["beta", "gamma beta"]);
    });
  });
});

describe("InteractiveSession output search", () => {
  let session: InteractiveSession;

  const NONCE_RE = /join \{ORMCP DONE (\S+)\}/;

  function makePty(target: InteractiveSession, nextOutput: () => string): PtyHandler {
    return {
      isProcessAlive: vi.fn().mockReturnValue(true),
      createSession: vi.fn().mockResolvedValue(undefined),
      writeInput: vi.fn().mockImplementation((data: string) => {
        void target.outputBuffer.append(data.replace(/\r$/, "\r\n"));
        const m = NONCE_RE.exec(data);
        if (!m) return;
        setTimeout(() => {
          void target.outputBuffer.append(nextOutput());
          void target.outputBuffer.append(`ORMCP-DONE-${m[1]}\r\n`);
        }, 5);
      }),
      terminateProcess: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn().mockResolvedValue(undefined),
      waitForExit: vi.fn().mockResolvedValue(null),
      validateCommand: vi.fn(),
    } as unknown as PtyHandler;
  }

  beforeEach(async () => {
    session = new InteractiveSession("grep-session", 65536);
    session.pty = makePty(session, () => "");
  });

  afterEach(async () => {
    await session.cleanup();
    vi.clearAllMocks();
  });

  it("finds output from a command that has already returned", async () => {
    // The regression: runCommand drains the circular buffer to empty, so a
    // search over the live buffer alone finds nothing once the command is done.
    let out = "wns max -0.485\r\ntns max -12.3\r\n";
    session.pty = makePty(session, () => out);
    await session.start(["openroad"]);
    const result = await session.runCommand("report_checks", 2000);
    expect(result.output).toContain("wns max -0.485");

    expect(session.outputBuffer.size).toBe(0);
    const grep = await session.grepOutput("wns");

    expect(grep.matches).toHaveLength(1);
    expect(grep.matches[0]!.line).toContain("wns max -0.485");
    expect(grep.matches[0]!.command).toBe("report_checks");
  });

  it("searches across several commands and attributes each match", async () => {
    let out = "cts__timing__setup__ws 0.1\r\n";
    session.pty = makePty(session, () => out);
    await session.start(["openroad"]);
    await session.runCommand("report_cts", 2000);
    out = "finish__timing__setup__ws -0.4\r\n";
    await session.runCommand("report_finish", 2000);

    const grep = await session.grepOutput("setup__ws");

    expect(grep.totalMatches).toBe(2);
    expect(grep.searchedCommands).toBe(2);
    expect(grep.matches.map((m) => m.command)).toEqual(["report_cts", "report_finish"]);
    expect(grep.matches[0]!.commandNumber).not.toBe(grep.matches[1]!.commandNumber);
  });

  it("can be scoped to one command's output", async () => {
    let out = "shared marker A\r\n";
    session.pty = makePty(session, () => out);
    await session.start(["openroad"]);
    await session.runCommand("first", 2000);
    out = "shared marker B\r\n";
    await session.runCommand("second", 2000);

    const all = await session.grepOutput("shared marker");
    const scoped = await session.grepOutput("shared marker", {
      commandNumber: all.matches[1]!.commandNumber,
    });

    expect(all.totalMatches).toBe(2);
    expect(scoped.totalMatches).toBe(1);
    expect(scoped.matches[0]!.command).toBe("second");
  });

  it("returns surrounding lines when context is requested", async () => {
    let out = "row one\r\nrow two\r\nTARGET row\r\nrow four\r\nrow five\r\n";
    session.pty = makePty(session, () => out);
    await session.start(["openroad"]);
    await session.runCommand("report_checks", 2000);

    const grep = await session.grepOutput("TARGET", { contextLines: 2 });

    expect(grep.matches[0]!.before).toEqual(["row one", "row two"]);
    expect(grep.matches[0]!.after).toEqual(["row four", "row five"]);
  });

  it("reports its own capping instead of returning a capped list as the whole answer", async () => {
    let out = Array.from({ length: 40 }, (_, i) => `slack path ${i}`).join("\r\n") + "\r\n";
    session.pty = makePty(session, () => out);
    await session.start(["openroad"]);
    await session.runCommand("report_checks", 2000);

    const grep = await session.grepOutput("slack path", { maxMatches: 5 });

    expect(grep.matches).toHaveLength(5);
    expect(grep.totalMatches).toBe(40);
    expect(grep.truncated).toBe(true);
  });

  it("treats an uncompilable pattern as a literal rather than erroring", async () => {
    let out = "net dpath.a_reg[0 loaded\r\n";
    session.pty = makePty(session, () => out);
    await session.start(["openroad"]);
    await session.runCommand("report_net", 2000);

    const grep = await session.grepOutput("dpath.a_reg[0");

    expect(grep.patternKind).toBe("substring");
    expect(grep.totalMatches).toBe(1);
  });

  it("retries literally when a valid regex matches nothing", async () => {
    // `dpath.a_reg[0]` compiles fine but means "…a_reg followed by 0", so it
    // matches nothing -- worse than a syntax error, because the caller is told
    // there are no matches when it is the pattern that is wrong.
    let out = "net dpath.a_reg[0] loaded\r\n";
    session.pty = makePty(session, () => out);
    await session.start(["openroad"]);
    await session.runCommand("report_net", 2000);

    const grep = await session.grepOutput("dpath.a_reg[0]");

    expect(grep.patternKind).toBe("substring-fallback");
    expect(grep.totalMatches).toBe(1);
    expect(grep.matches[0]!.line).toContain("dpath.a_reg[0]");
  });

  it("does not fall back when the regex genuinely matches nothing", async () => {
    let out = "nothing of interest here\r\n";
    session.pty = makePty(session, () => out);
    await session.start(["openroad"]);
    await session.runCommand("report_net", 2000);

    const grep = await session.grepOutput("wns.*slack");

    expect(grep.patternKind).toBe("regex");
    expect(grep.totalMatches).toBe(0);
  });

  it("honours case sensitivity when asked", async () => {
    let out = "Error: bad\r\nerror: worse\r\n";
    session.pty = makePty(session, () => out);
    await session.start(["openroad"]);
    await session.runCommand("report", 2000);

    expect((await session.grepOutput("Error")).totalMatches).toBe(2);
    expect((await session.grepOutput("Error", { ignoreCase: false })).totalMatches).toBe(1);
  });

  it("evicts the oldest output to stay inside the retention budget, and says so", async () => {
    const settings = new Settings({ OUTPUT_HISTORY_COMMANDS: 2, OUTPUT_HISTORY_CHARS: 1_000_000 });
    session = new InteractiveSession("evicting", 65536, settings);
    let out = "marker one\r\n";
    session.pty = makePty(session, () => out);
    await session.start(["openroad"]);
    await session.runCommand("first", 2000);
    out = "marker two\r\n";
    await session.runCommand("second", 2000);
    out = "marker three\r\n";
    await session.runCommand("third", 2000);

    const grep = await session.grepOutput("marker");

    expect(grep.totalMatches).toBe(2);
    expect(grep.evictedCommands).toBe(1);
    expect(grep.matches.map((m) => m.line.trim())).toEqual(["marker two", "marker three"]);
  });

  it("searches output still sitting unread in the buffer", async () => {
    await session.outputBuffer.append("pending wns -0.9\n");

    const grep = await session.grepOutput("wns");

    expect(grep.totalMatches).toBe(1);
    expect(grep.matches[0]!.command).toBe("(unread buffer)");
  });

  it("reports an empty search rather than pretending nothing matched", async () => {
    const grep = await session.grepOutput("anything");

    expect(grep.totalMatches).toBe(0);
    expect(grep.searchedCommands).toBe(0);
    expect(grep.retainedChars).toBe(0);
  });
});
