import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { CLIConfig } from "./config/cli.js";
import { manager as defaultManager } from "./core/manager.js";
import type { OpenROADManager } from "./core/manager.js";
import { cleanupManager } from "./utils/cleanup.js";
import { getLogger } from "./utils/logging.js";
import {
  CreateSessionTool,
  ExecShellTool,
  InspectSessionTool,
  ListSessionsTool,
  QueryShellTool,
  SessionHistoryTool,
  SessionMetricsTool,
  TerminateSessionTool,
  GrepSessionOutputTool,
} from "./tools/interactive.js";
import { ListReportImagesTool, ReadReportImageTool } from "./tools/report_images.js";
import { ReadOrfsMetricsTool } from "./tools/orfs_metrics.js";
import { RunOrfsStageTool, GetOrfsJobTool, CancelOrfsJobTool } from "./tools/flow_run.js";
import { flowJobs } from "./core/flow_jobs.js";

const logger = getLogger("server");

// Read from package.json so the advertised version never drifts from `npm version` at release.
const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/**
 * Appended to both shell tool descriptions. Output that exceeds the session
 * buffer loses its head, and a result that begins mid-line otherwise reads as
 * a complete answer -- so the caller has to be told these fields exist.
 */
const TRUNCATION_FIELD_DOC =
  "Results carry `truncated`, `bytes_discarded` and `total_bytes`: when `truncated` is true the " +
  "output lost its beginning to the session buffer and is a PARTIAL answer, so do not treat it as " +
  "complete — narrow the command and re-run.";

function text(value: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text" as const, text: value }] };
}

// Builds an McpServer with all 15 tools registered, mirroring Python server.py's wire contract.
// Accepts an optional manager so tests can inject an isolated/mocked one.
export function createMcpServer(manager: OpenROADManager = defaultManager): McpServer {
  const mcp = new McpServer({ name: "openroad-mcp", version: VERSION });

  const queryTool = new QueryShellTool(manager);
  const execTool = new ExecShellTool(manager);
  const listSessionsTool = new ListSessionsTool(manager);
  const createSessionTool = new CreateSessionTool(manager);
  const terminateSessionTool = new TerminateSessionTool(manager);
  const inspectSessionTool = new InspectSessionTool(manager);
  const sessionHistoryTool = new SessionHistoryTool(manager);
  const sessionMetricsTool = new SessionMetricsTool(manager);
  const listReportImagesTool = new ListReportImagesTool(manager);
  const readReportImageTool = new ReadReportImageTool(manager);
  const grepSessionOutputTool = new GrepSessionOutputTool(manager);
  const readOrfsMetricsTool = new ReadOrfsMetricsTool(manager);
  const runOrfsStageTool = new RunOrfsStageTool(manager);
  const getOrfsJobTool = new GetOrfsJobTool(manager);
  const cancelOrfsJobTool = new CancelOrfsJobTool(manager);

  mcp.registerTool(
    "interactive_openroad_query",
    {
      description:
        "Execute a read-only OpenROAD command (report_*, get_*, check_*, sta, help, etc.). " +
        "Use this for querying design state, generating reports, and inspecting timing. " +
        "Commands that modify design state are blocked — use interactive_openroad_exec instead. " +
        TRUNCATION_FIELD_DOC,
      inputSchema: {
        command: z.string(),
        session_id: z.string().optional(),
        timeout_ms: z.number().int().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => text(await queryTool.execute(args.command, args.session_id, args.timeout_ms)),
  );

  mcp.registerTool(
    "interactive_openroad_exec",
    {
      description:
        "Execute a state-modifying OpenROAD command (set_*, create_*, read_*, write_*, flow commands). " +
        "Use this for loading designs, running placement/routing, applying constraints, and writing " +
        "output files. Only the BLOCKED_COMMANDS list (quit, socket, load, glob, etc.) is rejected; " +
        "read-only commands such as report_* are also accepted here. Use interactive_openroad_query " +
        "instead for queries to keep state changes visible and auditable. " +
        TRUNCATION_FIELD_DOC,
      inputSchema: {
        command: z.string(),
        session_id: z.string().optional(),
        timeout_ms: z.number().int().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => text(await execTool.execute(args.command, args.session_id, args.timeout_ms)),
  );

  mcp.registerTool(
    "list_interactive_sessions",
    {
      description: "List all active interactive OpenROAD sessions.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => text(await listSessionsTool.execute()),
  );

  mcp.registerTool(
    "create_interactive_session",
    {
      description: "Create a new interactive OpenROAD session.",
      inputSchema: {
        session_id: z.string().optional(),
        command: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
        cwd: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      text(await createSessionTool.execute(args.session_id, args.command, args.env, args.cwd)),
  );

  mcp.registerTool(
    "terminate_interactive_session",
    {
      description: "Terminate an interactive OpenROAD session.",
      inputSchema: {
        session_id: z.string(),
        force: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => text(await terminateSessionTool.execute(args.session_id, args.force ?? false)),
  );

  mcp.registerTool(
    "inspect_interactive_session",
    {
      description: "Get detailed inspection data for an interactive OpenROAD session.",
      inputSchema: { session_id: z.string() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => text(await inspectSessionTool.execute(args.session_id)),
  );

  mcp.registerTool(
    "get_session_history",
    {
      description: "Get command history for an interactive OpenROAD session.",
      inputSchema: {
        session_id: z.string(),
        limit: z.number().int().optional(),
        search: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      text(await sessionHistoryTool.execute(args.session_id, args.limit, args.search)),
  );

  mcp.registerTool(
    "get_session_metrics",
    {
      description: "Get comprehensive metrics for all interactive OpenROAD sessions.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => text(await sessionMetricsTool.execute()),
  );

  mcp.registerTool(
    "list_report_images",
    {
      description: "List available report images from ORFS runs organized by stage.",
      inputSchema: {
        platform: z.string(),
        design: z.string(),
        run_slug: z.string(),
        stage: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      text(await listReportImagesTool.execute(args.platform, args.design, args.run_slug, args.stage)),
  );

  mcp.registerTool(
    "read_report_image",
    {
      description:
        "Read a report image (congestion, IR-drop, placement, clock tree) and return it as a " +
        "viewable image alongside its metadata. Optionally pass max_size_kb to override the " +
        "configured base64 budget for this call; larger budgets keep more detail in heatmaps.",
      inputSchema: {
        platform: z.string(),
        design: z.string(),
        run_slug: z.string(),
        image_name: z.string(),
        max_size_kb: z.number().int().positive().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const { blocks, isError } = await readReportImageTool.executeContent(
        args.platform,
        args.design,
        args.run_slug,
        args.image_name,
        args.max_size_kb,
      );
      return { content: blocks, ...(isError && { isError: true }) };
    },
  );

  mcp.registerTool(
    "grep_session_output",
    {
      description:
        "Search the output of commands already run in a session, without re-running them or " +
        "re-sending a large result. `pattern` is a regular expression, falling back to a substring " +
        "search if it does not compile. Use `context_lines` to see surrounding lines and " +
        "`command_number` to search one command's output. Only recent output is retained " +
        "(OPENROAD_OUTPUT_HISTORY_CHARS, default 256 KB); the result reports how much was searched " +
        "and whether older output has been evicted.",
      inputSchema: {
        session_id: z.string(),
        pattern: z.string(),
        max_matches: z.number().int().positive().optional(),
        context_lines: z.number().int().nonnegative().optional(),
        ignore_case: z.boolean().optional(),
        command_number: z.number().int().positive().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      text(
        await grepSessionOutputTool.execute(
          args.session_id,
          args.pattern,
          args.max_matches,
          args.context_lines,
          args.ignore_case,
          args.command_number,
        ),
      ),
  );

  mcp.registerTool(
    "read_orfs_metrics",
    {
      description:
        "Read an ORFS design's per-stage metrics, its rules-base.json gate thresholds evaluated " +
        "against those metrics, and the tagged errors/warnings from each stage log. Prefer this " +
        "over shelling out to find/cat/jq/grep in the flow tree. `stage` accepts a step name " +
        "(cts, place, route, floorplan, synth, finish), an ORFS metric namespace " +
        "(globalroute, detailedroute, placeopt, detailedplace), an exact file stem (4_1_cts), or " +
        "`all` (the default). `platform` is inferred from `design` when unambiguous. Note that " +
        "ORFS records some metrics once per sub-run: any key listed in `repeated_metrics` has an " +
        "array of values in file order rather than a scalar.",
      inputSchema: {
        design: z.string(),
        stage: z.string().optional(),
        platform: z.string().optional(),
        variant: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      text(
        await readOrfsMetricsTool.execute(
          args.design,
          args.stage,
          args.platform,
          args.variant,
        ),
      ),
  );

  mcp.registerTool(
    "run_orfs_stage",
    {
      description:
        "Run an ORFS flow stage (synth, floorplan, place, cts, grt, route, finish, or a clean_* " +
        "target) via make, streaming output to a file rather than the session buffer. Returns a " +
        "job_id immediately so a multi-hour route does not block the call; pass wait_seconds to " +
        "get the finished result inline when the stage is short. `overrides` become make " +
        "command-line assignments (e.g. {\"CTS_CLUSTER_SIZE\": \"20\"}), which take precedence " +
        "over both the environment and the Makefile. Poll with get_orfs_job for live progress, " +
        "and the parsed stage metrics and gate verdicts once it finishes. Set dry_run to see what " +
        "make would do without running it.",
      inputSchema: {
        design: z.string(),
        stage: z.string(),
        overrides: z.record(z.string(), z.string()).optional(),
        platform: z.string().optional(),
        variant: z.string().optional(),
        wait_seconds: z.number().int().positive().optional(),
        jobs: z.number().int().positive().optional(),
        timeout_seconds: z.number().int().positive().optional(),
        dry_run: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      text(
        await runOrfsStageTool.execute(
          args.design,
          args.stage,
          args.overrides,
          args.platform,
          args.variant,
          args.wait_seconds,
          args.jobs,
          args.timeout_seconds,
          args.dry_run,
        ),
      ),
  );

  mcp.registerTool(
    "get_orfs_job",
    {
      description:
        "Poll a flow run started by run_orfs_stage: status, elapsed time, the ORFS stage currently " +
        "executing, detailed-route iteration and live DRC violation count, CPU and memory, and the " +
        "tail of the run log. Once the run succeeds it also carries the parsed stage metrics and " +
        "rules-base gate verdicts. Omit job_id to list every run.",
      inputSchema: {
        job_id: z.string().optional(),
        recent_lines: z.number().int().positive().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => text(await getOrfsJobTool.execute(args.job_id, args.recent_lines)),
  );

  mcp.registerTool(
    "cancel_orfs_job",
    {
      description:
        "Terminate a running flow job and every process it spawned, so no orphaned openroad " +
        "process is left behind.",
      inputSchema: { job_id: z.string() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => text(await cancelOrfsJobTool.execute(args.job_id)),
  );

  return mcp;
}

// Module-level server instance for the production entrypoint; tests use createMcpServer() instead.
export const mcp = createMcpServer();

export async function shutdownOpenroad(): Promise<void> {
  logger.info("Initiating graceful shutdown...");
  try {
    await defaultManager.cleanupAll();
    logger.info("Graceful shutdown complete");
  } catch (e) {
    logger.error(`Error during shutdown: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Caps request bodies so a large or malicious POST can't buffer unbounded memory.
const MAX_BODY_BYTES = 1_000_000;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error(`Request body too large (>${MAX_BODY_BYTES} bytes)`);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return undefined;
  return JSON.parse(raw);
}

// Handles one HTTP request in stateless mode: a fresh server + transport per request avoids
// JSON-RPC id collisions between clients: OpenROADManager owns session continuity separately.
async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestServer = createMcpServer();
  const transport = new StreamableHTTPServerTransport();
  res.on("close", () => {
    void transport.close();
    void requestServer.close();
  });
  try {
    // Cast works around an exactOptionalPropertyTypes mismatch in the SDK's onclose typing.
    await requestServer.connect(
      transport as unknown as Parameters<typeof requestServer.connect>[0],
    );
    const body = req.method === "POST" ? await readJsonBody(req) : undefined;
    await transport.handleRequest(req, res, body);
  } catch (e) {
    logger.error(`HTTP request error: ${e instanceof Error ? e.message : String(e)}`);
    if (!res.headersSent) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(
        JSON.stringify({ error: "Invalid request body" }),
      );
    }
  }
}

// Boots the MCP server for the configured transport and blocks until shutdown (SIGTERM/SIGINT
// or transport close), then cleans up every session.
export async function runServer(config: CLIConfig): Promise<void> {
  cleanupManager.registerAsyncCleanupHandler(shutdownOpenroad);
  // A flow run outlives the server otherwise: make and its openroad children
  // are in their own process group and would keep going after we exit.
  cleanupManager.registerAsyncCleanupHandler(() => flowJobs.shutdown());
  cleanupManager.setupSignalHandlers();

  try {
    if (config.transport.mode === "stdio") {
      // Treat a client disconnect / stdin EOF as a shutdown so the process doesn't hang.
      mcp.server.onclose = (): void => cleanupManager.triggerShutdown();
      const transport = new StdioServerTransport();
      await mcp.connect(transport);
      logger.info("MCP server running on stdio transport");
      await cleanupManager.waitForShutdown();
    } else {
      const httpServer = createServer((req: IncomingMessage, res: ServerResponse): void => {
        void handleHttpRequest(req, res);
      });

      const { host, port } = config.transport;
      // Surface a bind failure as a clean rejection instead of an uncaught 'error' event.
      await new Promise<void>((resolve, reject) => {
        const onListenError = (e: Error): void => {
          reject(new Error(`Failed to start HTTP server on ${host}:${port}: ${e.message}`));
        };
        httpServer.once("error", onListenError);
        httpServer.listen(port, host, (): void => {
          httpServer.removeListener("error", onListenError);
          resolve();
        });
      });

      // After a successful bind, log and trigger graceful shutdown instead of crashing.
      httpServer.on("error", (e: Error): void => {
        logger.error(`HTTP server error: ${e.message}`);
        cleanupManager.triggerShutdown();
      });

      logger.info(`MCP server running on http transport at ${host}:${port}`);
      await cleanupManager.waitForShutdown();
      await new Promise<void>((resolve) => httpServer.close(() => { resolve(); }));
    }
  } finally {
    await cleanupManager.runHandlers();
  }
}
