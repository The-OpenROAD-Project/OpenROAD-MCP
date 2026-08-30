#!/usr/bin/env node
import { parseCliArgs } from "./config/cli.js";
import { applyInheritedEnv } from "./config/path_env.js";
import { initSettings } from "./config/settings.js";
import { EXIT_CODE_ERROR } from "./constants.js";
import { ValidationError } from "./exceptions.js";

// logging/server are dynamic imports so settings validation happens inside this try/catch
// (a bad env var becomes a ValidationError, not an uncaught stack trace) and so loggers aren't
// built before the CLI log level is applied.
async function main(): Promise<void> {
  try {
    applyInheritedEnv();
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
