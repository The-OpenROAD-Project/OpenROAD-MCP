import pino from "pino";
import { getSettings } from "../config/settings.js";

/**
 * Pino-based logging for the MCP server.
 *
 * IMPORTANT: all log output goes to stderr (file descriptor 2). stdout is
 * reserved exclusively for the MCP stdio transport - writing logs there would
 * corrupt the JSON-RPC protocol stream.
 *
 * The root level is initialised from settings (env-driven) at module load so
 * child loggers created eagerly (e.g. the module-level OpenROADManager
 * singleton) honour the configured level without depending on setupLogging()
 * being called first. setupLogging() mutates the root level for loggers created
 * afterwards; note that pino child loggers capture their level at creation time
 * and do not dynamically follow the parent.
 */
function createRoot(level: string): pino.Logger {
  return pino({ name: "openroad_mcp", level: level.toLowerCase() }, pino.destination(2));
}

let rootLogger: pino.Logger = createRoot(getSettings().LOG_LEVEL);

/** Configure the root log level. Call once at startup before heavy logging. */
export function setupLogging(level: string): void {
  rootLogger.level = level.toLowerCase();
}

/** Return a child logger namespaced under `openroad_mcp.<name>`. */
export function getLogger(name: string): pino.Logger {
  return rootLogger.child({ module: name });
}
