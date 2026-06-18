import pino from "pino";
import { getSettings } from "../config/settings.js";

// All log output goes to stderr (fd 2). stdout is reserved for the MCP stdio
// transport and any log writes there would corrupt the JSON-RPC stream.
// pino child loggers capture their level at creation, so the root level is
// initialised from settings at module load to honour the configured level for
// eagerly created singletons.
function createRoot(level: string): pino.Logger {
  return pino({ name: "openroad_mcp", level: level.toLowerCase() }, pino.destination(2));
}

let rootLogger: pino.Logger = createRoot(getSettings().LOG_LEVEL);

export function setupLogging(level: string): void {
  rootLogger.level = level.toLowerCase();
}

export function getLogger(name: string): pino.Logger {
  return rootLogger.child({ module: name });
}
