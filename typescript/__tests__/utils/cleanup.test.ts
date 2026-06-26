import { describe, it, expect, vi, afterEach } from "vitest";
import { CleanupManager } from "../../src/utils/cleanup.js";
import { FORCE_EXIT_DELAY_SECONDS } from "../../src/constants.js";

describe("CleanupManager", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("runs registered handlers on runHandlers", async () => {
    const mgr = new CleanupManager();
    const ran: string[] = [];
    mgr.registerAsyncCleanupHandler(() => {
      ran.push("a");
    });
    mgr.registerAsyncCleanupHandler(async () => {
      await Promise.resolve();
      ran.push("b");
    });

    await mgr.runHandlers();

    expect(ran).toEqual(["a", "b"]);
  });

  it("isolates a throwing handler so later handlers still run", async () => {
    const mgr = new CleanupManager();
    const ran: string[] = [];
    mgr.registerAsyncCleanupHandler(() => {
      throw new Error("boom");
    });
    mgr.registerAsyncCleanupHandler(() => {
      ran.push("after");
    });

    await expect(mgr.runHandlers()).resolves.toBeUndefined();
    expect(ran).toEqual(["after"]);
  });

  it("triggerShutdown resolves waitForShutdown", async () => {
    const mgr = new CleanupManager();
    let resolved = false;
    const wait = mgr.waitForShutdown().then(() => {
      resolved = true;
    });

    mgr.triggerShutdown();
    await wait;

    expect(resolved).toBe(true);
  });

  it("triggerShutdown is idempotent", async () => {
    const mgr = new CleanupManager();
    mgr.triggerShutdown();
    mgr.triggerShutdown(); // second call must be a no-op, not throw
    await expect(mgr.waitForShutdown()).resolves.toBeUndefined();
  });

  it("a signal triggers shutdown and arms the force-exit timer", async () => {
    vi.useFakeTimers();
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    const sigtermBefore = process.listeners("SIGTERM");
    const sigintBefore = process.listeners("SIGINT");

    try {
      const mgr = new CleanupManager();
      mgr.setupSignalHandlers();

      let resolved = false;
      const wait = mgr.waitForShutdown().then(() => {
        resolved = true;
      });

      process.emit("SIGTERM", "SIGTERM");
      await wait;
      expect(resolved).toBe(true);

      // Force-exit fires only after the configured delay.
      expect(exitSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(FORCE_EXIT_DELAY_SECONDS * 1000);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      // Remove only the listeners this test added, leaving the runner's intact.
      for (const l of process.listeners("SIGTERM")) {
        if (!sigtermBefore.includes(l)) process.removeListener("SIGTERM", l);
      }
      for (const l of process.listeners("SIGINT")) {
        if (!sigintBefore.includes(l)) process.removeListener("SIGINT", l);
      }
    }
  });
});
