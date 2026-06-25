import { FORCE_EXIT_DELAY_SECONDS } from "../constants.js";
import { getLogger } from "./logging.js";

const logger = getLogger("cleanup");

type CleanupHandler = () => Promise<void> | void;

/**
 * Coordinates graceful shutdown. Node is single-threaded and event-driven, so
 * this collapses the Python atexit/signal/threading version into process signal
 * handlers plus a single shutdown promise.
 *
 * `waitForShutdown()` blocks the server lifecycle until either a signal arrives
 * or the transport closes (both call `triggerShutdown()`). A signal also arms an
 * unref'd force-exit timer so a hung graceful shutdown still exits the process.
 */
export class CleanupManager {
  private shutdownInitiated = false;
  private readonly handlers: CleanupHandler[] = [];

  private resolveShutdown: (() => void) | null = null;
  private readonly shutdownPromise: Promise<void> = new Promise((resolve) => {
    this.resolveShutdown = resolve;
  });

  /** Register a handler to run during graceful shutdown (sync or async). */
  registerAsyncCleanupHandler(handler: CleanupHandler): void {
    this.handlers.push(handler);
  }

  /** Install SIGTERM/SIGINT handlers that trigger shutdown and arm a force-exit. */
  setupSignalHandlers(): void {
    const onSignal = (signal: NodeJS.Signals): void => {
      if (this.shutdownInitiated) return;
      logger.info(
        `Received ${signal}, shutting down (forcing exit in ${FORCE_EXIT_DELAY_SECONDS}s if it hangs)`,
      );
      // Force-exit safety net: if graceful shutdown stalls, leave anyway. The
      // timer is unref'd so it never keeps the event loop alive on its own.
      const timer = setTimeout(() => process.exit(0), FORCE_EXIT_DELAY_SECONDS * 1000);
      timer.unref();
      this.triggerShutdown();
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  }

  /**
   * Unblock `waitForShutdown()`. Idempotent: a second signal or a transport
   * close after the first is a no-op. Called by the signal handlers and by the
   * stdio transport's onclose.
   */
  triggerShutdown(): void {
    if (this.shutdownInitiated) return;
    this.shutdownInitiated = true;
    this.resolveShutdown?.();
  }

  /** Resolves once shutdown is triggered. */
  async waitForShutdown(): Promise<void> {
    await this.shutdownPromise;
  }

  /** Run every registered cleanup handler, isolating failures. */
  async runHandlers(): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler();
      } catch (e) {
        logger.error(`Error in cleanup handler: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

// Global cleanup manager instance (matches server.py's module-level singleton).
export const cleanupManager = new CleanupManager();
