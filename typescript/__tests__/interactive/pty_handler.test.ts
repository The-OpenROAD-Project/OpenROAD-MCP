import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { IPty } from "node-pty";
import { PTYError } from "../../src/interactive/models.js";
import { Settings } from "../../src/config/settings.js";

vi.mock("node-pty", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node-pty";
import { PtyHandler } from "../../src/interactive/pty_handler.js";

type MockPty = {
  pid: number;
  write: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  _fire: (data: string) => void;
  _exit: (code: number) => void;
};

function makeMockPty(): MockPty {
  let capturedOnData: ((data: string) => void) | undefined;
  let capturedOnExit: ((e: { exitCode: number; signal?: number }) => void) | undefined;

  return {
    pid: 12345,
    write: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn((cb: (data: string) => void) => {
      capturedOnData = cb;
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => {
      capturedOnExit = cb;
      return { dispose: vi.fn() };
    }),
    _fire: (data: string) => capturedOnData?.(data),
    _exit: (code: number) => capturedOnExit?.({ exitCode: code }),
  };
}

const validationDisabledSettings = new Settings({ ENABLE_COMMAND_VALIDATION: false });

describe("PtyHandler", () => {
  let handler: PtyHandler;
  let mockPty: MockPty;

  beforeEach(() => {
    handler = new PtyHandler(validationDisabledSettings);
    mockPty = makeMockPty();
    vi.mocked(spawn).mockReturnValue(mockPty as unknown as IPty);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("initialization", () => {
    it("starts with all fields null/false", () => {
      const h = new PtyHandler(validationDisabledSettings);
      expect(h.isProcessAlive()).toBe(false);
    });
  });

  describe("createSession", () => {
    it("calls spawn with correct arguments including terminal env vars", async () => {
      await handler.createSession(["echo", "hello"], { TEST: "value" }, "/tmp");

      expect(vi.mocked(spawn)).toHaveBeenCalledOnce();
      const call = vi.mocked(spawn).mock.calls[0]!;
      expect(call[0]).toBe("echo");
      expect(call[1]).toEqual(["hello"]);
      const opts = call[2]!;
      expect(opts.cwd).toBe("/tmp");
      expect((opts.env as Record<string, string>)["TEST"]).toBe("value");
      expect((opts.env as Record<string, string>)["TERM"]).toBe("xterm-256color");
      expect((opts.env as Record<string, string>)["COLUMNS"]).toBe("80");
      expect((opts.env as Record<string, string>)["LINES"]).toBe("24");
    });

    it("marks process as alive after createSession", async () => {
      await handler.createSession(["echo"]);
      expect(handler.isProcessAlive()).toBe(true);
    });

    it("wires onData callback so buffer receives data", async () => {
      const received: string[] = [];
      await handler.createSession(["echo"], undefined, undefined, (d) => received.push(d));

      mockPty._fire("hello from pty");
      expect(received).toEqual(["hello from pty"]);
    });

    it("throws PTYError when spawn throws", async () => {
      vi.mocked(spawn).mockImplementation(() => {
        throw new Error("spawn failed");
      });

      await expect(handler.createSession(["echo"])).rejects.toThrow(PTYError);
      await expect(handler.createSession(["echo"])).rejects.toThrow("Failed to create PTY session");
    });

    it("registers onExit and marks process dead when it fires", async () => {
      await handler.createSession(["echo"]);
      expect(handler.isProcessAlive()).toBe(true);

      mockPty._exit(0);
      expect(handler.isProcessAlive()).toBe(false);
    });

    it("calls the external onExit callback when the process exits", async () => {
      const exitCodes: number[] = [];
      await handler.createSession(["echo"], undefined, undefined, undefined, (code) =>
        exitCodes.push(code),
      );

      mockPty._exit(42);
      expect(exitCodes).toEqual([42]);
    });
  });

  describe("writeInput", () => {
    it("forwards data to ptyProcess.write", async () => {
      await handler.createSession(["echo"]);
      handler.writeInput("hello\n");
      expect(mockPty.write).toHaveBeenCalledWith("hello\n");
    });

    it("throws PTYError when no active process", () => {
      expect(() => handler.writeInput("test")).toThrow(PTYError);
      expect(() => handler.writeInput("test")).toThrow("Cannot write: no active PTY process");
    });

    it("throws PTYError when ptyProcess.write throws", async () => {
      await handler.createSession(["echo"]);
      mockPty.write.mockImplementation(() => {
        throw new Error("write failed");
      });

      expect(() => handler.writeInput("test")).toThrow(PTYError);
      expect(() => handler.writeInput("test")).toThrow("Failed to write to PTY");
    });
  });

  describe("isProcessAlive", () => {
    it("returns false before createSession", () => {
      expect(handler.isProcessAlive()).toBe(false);
    });

    it("returns true after createSession", async () => {
      await handler.createSession(["echo"]);
      expect(handler.isProcessAlive()).toBe(true);
    });

    it("returns false after onExit fires", async () => {
      await handler.createSession(["echo"]);
      mockPty._exit(0);
      expect(handler.isProcessAlive()).toBe(false);
    });
  });

  describe("waitForExit", () => {
    it("returns null when no process exists", async () => {
      const result = await handler.waitForExit();
      expect(result).toBeNull();
    });

    it("returns exit code when process has already exited", async () => {
      await handler.createSession(["echo"]);
      mockPty._exit(0);
      const result = await handler.waitForExit();
      expect(result).toBe(0);
    });

    it("returns null on timeout when process has not exited", async () => {
      await handler.createSession(["echo"]);
      const result = await handler.waitForExit(10);
      expect(result).toBeNull();
    });

    it("resolves when process exits before timeout", async () => {
      await handler.createSession(["echo"]);

      setTimeout(() => mockPty._exit(1), 10);
      const result = await handler.waitForExit(200);
      expect(result).toBe(1);
    });

    it("both concurrent waiters resolve when process exits (no single-slot loss)", async () => {
      await handler.createSession(["echo"]);

      setTimeout(() => mockPty._exit(42), 10);
      const [r1, r2] = await Promise.all([handler.waitForExit(200), handler.waitForExit(200)]);
      expect(r1).toBe(42);
      expect(r2).toBe(42);
    });

    it("cleanup() resolves pending waitForExit with null when process never exited", async () => {
      await handler.createSession(["echo"]);

      // Stub terminateProcess so cleanup() doesn't block for 5 s internally
      vi.spyOn(handler, "terminateProcess").mockResolvedValue(undefined);

      const waiter = handler.waitForExit(10000);
      await handler.cleanup();

      const result = await waiter;
      expect(result).toBeNull();
    });
  });

  describe("terminateProcess", () => {
    it("does nothing when no process exists", async () => {
      await expect(handler.terminateProcess()).resolves.toBeUndefined();
    });

    it("does nothing when process is already dead", async () => {
      await handler.createSession(["echo"]);
      mockPty._exit(0);
      await handler.terminateProcess();
      expect(mockPty.kill).not.toHaveBeenCalled();
    });

    it("sends SIGKILL and waits for exit when force=true", async () => {
      await handler.createSession(["echo"]);

      setTimeout(() => mockPty._exit(137), 5);
      await handler.terminateProcess(true);

      expect(mockPty.kill).toHaveBeenCalledWith("SIGKILL");
      expect(mockPty.kill).not.toHaveBeenCalledWith("SIGTERM");
      expect(handler.isProcessAlive()).toBe(false);
    });

    it("cleanup after force terminate does not resend SIGTERM (no 5-second hang)", async () => {
      await handler.createSession(["echo"]);

      // force=true: SIGKILL sent, process exits, _alive=false before terminateProcess returns
      setTimeout(() => mockPty._exit(137), 5);
      await handler.terminateProcess(true);

      // cleanup() must see _alive=false and skip terminateProcess entirely
      await handler.cleanup();

      expect(mockPty.kill).toHaveBeenCalledTimes(1);
      expect(mockPty.kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("sends SIGTERM for graceful shutdown when force=false", async () => {
      await handler.createSession(["echo"]);

      setTimeout(() => mockPty._exit(0), 5);
      await handler.terminateProcess(false);

      expect(mockPty.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("sends SIGKILL after graceful timeout when process does not exit", async () => {
      await handler.createSession(["echo"]);

      const originalWaitForExit = handler.waitForExit.bind(handler);
      vi.spyOn(handler, "waitForExit").mockImplementation(async (ms) => {
        if (ms === 5000) return null;
        return originalWaitForExit(ms);
      });

      // Simulate kernel acknowledging SIGKILL so the subsequent waitForExit() resolves
      mockPty.kill.mockImplementation((signal: string) => {
        if (signal === "SIGKILL") setTimeout(() => mockPty._exit(137), 0);
      });

      await handler.terminateProcess(false);
      expect(mockPty.kill).toHaveBeenCalledWith("SIGTERM");
      expect(mockPty.kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("waitForExit callers receive 137 when cleanup follows SIGKILL-forced termination so the exit listener is not disposed before the exit fires", async () => {
      await handler.createSession(["echo"]);

      const originalWaitForExit = handler.waitForExit.bind(handler);
      vi.spyOn(handler, "waitForExit").mockImplementation(async (ms) => {
        if (ms === 5000) return null;
        return originalWaitForExit(ms);
      });

      mockPty.kill.mockImplementation((signal: string) => {
        if (signal === "SIGKILL") setTimeout(() => mockPty._exit(137), 0);
      });

      const waiter = handler.waitForExit(10000);
      await handler.terminateProcess(false);
      // terminateProcess() must have already awaited SIGKILL so _exitCode = 137;
      // cleanup() disposing _exitDisposable here cannot race the exit listener
      await handler.cleanup();

      expect(await waiter).toBe(137);
    });

    it("does not throw when SIGTERM kill raises (process already dead)", async () => {
      await handler.createSession(["echo"]);
      mockPty.kill.mockImplementation(() => {
        throw new Error("ESRCH: no such process");
      });

      await expect(handler.terminateProcess(false)).resolves.toBeUndefined();
    });

    it("does not throw when SIGKILL raises (process already dead)", async () => {
      await handler.createSession(["echo"]);
      mockPty.kill.mockImplementation(() => {
        throw new Error("ESRCH: no such process");
      });

      await expect(handler.terminateProcess(true)).resolves.toBeUndefined();
    });
  });

  describe("cleanup", () => {
    it("disposes event listeners and resets state", async () => {
      await handler.createSession(["echo"]);
      mockPty._exit(0);

      await handler.cleanup();

      expect(handler.isProcessAlive()).toBe(false);
    });

    it("calls dispose on registered IDisposables", async () => {
      await handler.createSession(["echo"], undefined, undefined, () => {});
      const dataDispose = (mockPty.onData.mock.results[0]! as { value: { dispose: ReturnType<typeof vi.fn> } }).value
        .dispose;
      const exitDispose = (mockPty.onExit.mock.results[0]! as { value: { dispose: ReturnType<typeof vi.fn> } }).value
        .dispose;

      mockPty._exit(0);
      await handler.cleanup();

      expect(dataDispose).toHaveBeenCalledOnce();
      expect(exitDispose).toHaveBeenCalledOnce();
    });

    it("resets state even when terminateProcess throws (best-effort)", async () => {
      await handler.createSession(["echo"]);

      vi.spyOn(handler, "terminateProcess").mockRejectedValueOnce(new Error("kill failed"));

      await expect(handler.cleanup()).resolves.toBeUndefined();
      expect(handler.isProcessAlive()).toBe(false);
    });

    it("resets state even when dispose throws (best-effort)", async () => {
      const throwingDispose = vi.fn().mockImplementation(() => {
        throw new Error("dispose failed");
      });
      mockPty.onData.mockReturnValueOnce({ dispose: throwingDispose });

      await handler.createSession(["echo"], undefined, undefined, () => {});
      mockPty._exit(0);

      await expect(handler.cleanup()).resolves.toBeUndefined();
      expect(handler.isProcessAlive()).toBe(false);
      expect(throwingDispose).toHaveBeenCalledOnce();
    });
  });

  describe("buffer empty when no data fired", () => {
    it("onData has not fired so no data reaches the consumer", async () => {
      const received: string[] = [];
      await handler.createSession(["echo"], undefined, undefined, (d) => received.push(d));
      expect(received).toHaveLength(0);
    });
  });

  describe("full lifecycle", () => {
    it("create -> write -> data arrives via onData -> exit", async () => {
      const received: string[] = [];
      const exitCodes: number[] = [];

      await handler.createSession(
        ["openroad"],
        {},
        undefined,
        (d) => received.push(d),
        (c) => exitCodes.push(c),
      );

      expect(handler.isProcessAlive()).toBe(true);

      handler.writeInput("hello\n");
      expect(mockPty.write).toHaveBeenCalledWith("hello\n");

      mockPty._fire("openroad> ");
      expect(received).toEqual(["openroad> "]);

      mockPty._exit(0);
      expect(handler.isProcessAlive()).toBe(false);
      expect(exitCodes).toEqual([0]);
    });
  });
});
