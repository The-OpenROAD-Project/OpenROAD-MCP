#!/usr/bin/env node
import { parseCliArgs } from "./config/cli.js";
import { initSettings } from "./config/settings.js";
import { EXIT_CODE_ERROR } from "./constants.js";
import { ValidationError } from "./exceptions.js";

/**
 * Entry point. The eager work (settings validation, CLI parsing) runs before
 * any module that reads settings or builds a logger is imported.
 *
 * This ordering matters and is why `logging` and `server` are dynamic imports:
 * `utils/logging` calls `getSettings()` at module load to seed the root logger,
 * and `server` builds the manager (and its child logger) at load. Importing
 * either statically would validate settings before main()'s try/catch (turning
 * a bad env var into an uncaught stack trace) and create loggers before the CLI
 * log level is applied. Only pure modules are imported statically here.
 */
async function main(): Promise<void> {
  try {
    initSettings();
  } catch (e) {
    throw new ValidationError(e instanceof Error ? e.message : String(e));
  }

  const config = parseCliArgs();

  const { setupLogging } = await import("./utils/logging.js");
  setupLogging(config.verbose ? "DEBUG" : config.logLevel);

  const { runServer } = await import("./server.js");
  await runServer(config);
}

main().catch((e: unknown) => {
  if (e instanceof ValidationError) {
    console.error(`Configuration error: ${e.message}`);
    process.exit(EXIT_CODE_ERROR);
  }
  console.error(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(EXIT_CODE_ERROR);
});
