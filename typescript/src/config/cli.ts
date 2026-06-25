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

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (Number.isNaN(port)) {
    throw new ValidationError(`Invalid --port value: ${value}`);
  }
  return port;
}

/**
 * Parse argv into a CLIConfig. Pass an explicit argument array (without the
 * node/script prefix) in tests; omit it to read process.argv.
 *
 * commander is configured with exitOverride so bad input throws a
 * ValidationError instead of calling process.exit, which keeps parsing testable
 * and lets main.ts map every config failure to a single exit code.
 */
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
      // --help / --version already printed their output; exit cleanly rather
      // than surfacing them as configuration errors.
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

  // HTTP host/port are meaningless for stdio; reject them so a misconfigured
  // command fails loudly instead of silently ignoring the flags.
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
