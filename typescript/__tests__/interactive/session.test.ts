import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InteractiveSession } from "../../src/interactive/session.js";
import { SessionState } from "../../src/core/models.js";
import { SessionError, SessionTerminatedError } from "../../src/interactive/models.js";
import { Settings } from "../../src/config/settings.js";
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
      expect(session.isAlive()).toBe(false);
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

    it("appends newline to command if missing", async () => {
      session.state = SessionState.ACTIVE;
      (mockPty.isProcessAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);

      await session.sendCommand("test command");
      expect(session.inputQueueSize()).toBe(1);

      await session.sendCommand("with newline\n");
      expect(session.commandCount).toBe(2);
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

      // Must NOT throw even though the session is terminated
      const result = await session.readOutput(100);

      expect(result.output).toContain("Exiting OpenROAD");
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
      expect(session.outputBuffer.size).toBe(0);
    });

    it("signals shutdown when readOutput detects terminated session so writer task does not loop indefinitely", async () => {
      // Spy on the private method to verify readOutput() calls it directly.
      // Scenario: _state was flipped to TERMINATED externally (e.g. via the setter)
      // without calling _signalShutdown() — the exact gap @luarss identified.
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
  });

  describe("isAlive", () => {
    it("returns false in CREATING state", () => {
      expect(session.state).toBe(SessionState.CREATING);
      expect(session.isAlive()).toBe(false);
    });

    it("returns false in ACTIVE state when process is dead", () => {
      session.state = SessionState.ACTIVE;
      (mockPty.isProcessAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);

      expect(session.isAlive()).toBe(false);
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

      expect(session.isAlive()).toBe(true);
      expect(session.state).toBe(SessionState.ACTIVE);
    });

    it("returns false in TERMINATED state", () => {
      session.state = SessionState.TERMINATED;
      expect(session.isAlive()).toBe(false);
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

      // terminate() without any follow-up cleanup() call
      await session.terminate(false);

      // pty.cleanup() must have been called to dispose _dataDisposable,
      // _exitDisposable, and drain _exitResolvers — otherwise post-kill
      // data bursts keep appending and waitForExit() callers hang forever
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

      // Should not throw or double-signal shutdown
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
      expect(session.isAlive()).toBe(false);
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
      expect(session.isAlive()).toBe(false);
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

    it("detects invalid command name pattern", async () => {
      await session.outputBuffer.append('invalid command name "foo_bar"\n');
      const result = await session.readOutput(100);
      expect(result.error).toMatch(/Invalid command/);
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
});
