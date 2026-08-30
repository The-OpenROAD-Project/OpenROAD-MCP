import { Command, Option } from "commander";
import { ValidationError } from "../exceptions.js";

export interface TransportConfig {
  mode: "stdio" | "http";
  host: string;
  port: number;
}

export interface CLIConfig {
  transport: TransportConfig;
  verbose: boolean;
  logLevel: string;
}

const DEFAULT_HOST = "localhost";
const DEFAULT_PORT = 8000;
const MIN_PORT = 1;
const MAX_PORT = 65535;

function parsePort(value: string): number {
  const trimmed = value.trim();
  const port = Number.parseInt(trimmed, 10);
  // Reject non-digits and out-of-range values here for a clear error instead of one from listen().
  if (!/^\d+$/.test(trimmed) || port < MIN_PORT || port > MAX_PORT) {
    throw new ValidationError(
      `Invalid --port value: '${value}'. Expected an integer between ${MIN_PORT} and ${MAX_PORT}.`,
    );
  }
  return port;
}

// Parses argv into a CLIConfig; exitOverride makes bad input throw ValidationError instead of
// calling process.exit, so main.ts can map every config failure to a single exit code.
export function parseCliArgs(argv?: string[]): CLIConfig {
  const program = new Command();
  program
    .name("openroad-mcp")
    .description("OpenROAD Model Context Protocol (MCP) Server")
    .addOption(
      new Option("-t, --transport <mode>", "Transport mode for the MCP server")
        .choices(["stdio", "http"])
        .default("stdio"),
    )
    .addOption(
      new Option("--host <host>", "HTTP server host (http mode only)").default(DEFAULT_HOST),
    )
    .addOption(
      new Option("--port <port>", "HTTP server port (http mode only)")
        .default(DEFAULT_PORT)
        .argParser(parsePort),
    )
    .option("-v, --verbose", "Enable verbose logging", false)
    .addOption(
      new Option("--log-level <level>", "Logging level")
        .choices(["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"])
        .default("INFO"),
    )
    .exitOverride((err) => {
      // --help / --version already printed their output; exit cleanly.
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
        process.exit(0);
      }
      throw new ValidationError(err.message);
    });

  try {
    if (argv === undefined) {
      program.parse();
    } else {
      program.parse(argv, { from: "user" });
    }
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError(e instanceof Error ? e.message : String(e));
  }

  const opts = program.opts();
  const mode = opts.transport as "stdio" | "http";
  const host = opts.host as string;
  const port = opts.port as number;

  // HTTP host/port are meaningless for stdio; reject rather than silently ignore them.
  if (mode !== "http" && (host !== DEFAULT_HOST || port !== DEFAULT_PORT)) {
    throw new ValidationError(
      "--host and --port options are only valid with --transport http",
    );
  }

  return {
    transport: { mode, host, port },
    verbose: Boolean(opts.verbose),
    logLevel: opts.logLevel as string,
  };
}
