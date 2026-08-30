import { EXIT_CODE_ERROR, FORCE_EXIT_DELAY_SECONDS } from "../constants.js";
import { getLogger } from "./logging.js";

const logger = getLogger("cleanup");

type CleanupHandler = () => Promise<void> | void;

// Coordinates graceful shutdown: waitForShutdown() blocks until a signal or transport close
// triggers it, and a signal also arms an unref'd force-exit timer as a safety net.
export class CleanupManager {
  private shutdownInitiated = false;
  private readonly handlers: CleanupHandler[] = [];

  private resolveShutdown: (() => void) | null = null;
  private readonly shutdownPromise: Promise<void> = new Promise((resolve) => {
    this.resolveShutdown = resolve;
  });

  registerAsyncCleanupHandler(handler: CleanupHandler): void {
    this.handlers.push(handler);
  }

  setupSignalHandlers(): void {
    const onSignal = (signal: NodeJS.Signals): void => {
      if (this.shutdownInitiated) return;
      logger.info(
        `Received ${signal}, shutting down (forcing exit in ${FORCE_EXIT_DELAY_SECONDS}s if it hangs)`,
      );
      // Force-exit safety net: exits non-zero since a forced exit is abnormal. Unref'd so it
      // never keeps the event loop alive on its own.
      const timer = setTimeout(() => {
        logger.error(
          `Graceful shutdown did not complete within ${FORCE_EXIT_DELAY_SECONDS}s; forcing exit`,
        );
        process.exit(EXIT_CODE_ERROR);
      }, FORCE_EXIT_DELAY_SECONDS * 1000);
      timer.unref();
      this.triggerShutdown();
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  }

  // Unblocks waitForShutdown(); idempotent against repeated signals/close events.
  triggerShutdown(): void {
    if (this.shutdownInitiated) return;
    this.shutdownInitiated = true;
    this.resolveShutdown?.();
  }

  async waitForShutdown(): Promise<void> {
    await this.shutdownPromise;
  }

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
