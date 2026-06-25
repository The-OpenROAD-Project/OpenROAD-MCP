import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
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
} from "./tools/interactive.js";
import { ListReportImagesTool, ReadReportImageTool } from "./tools/report_images.js";

const logger = getLogger("server");

const VERSION = "0.5.0";

/** Wrap a tool's JSON-string result in the MCP text-content envelope. */
function text(value: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text" as const, text: value }] };
}

/**
 * Build an McpServer with all 10 tools registered. Accepts an optional manager
 * so tests can inject an isolated/mocked one; defaults to the module singleton.
 *
 * Tool names, descriptions, input params, and annotations mirror the Python
 * server.py verbatim so the wire contract is unchanged across the migration.
 */
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

  mcp.registerTool(
    "interactive_openroad_query",
    {
      description:
        "Execute a read-only OpenROAD command (report_*, get_*, check_*, sta, help, etc.). " +
        "Use this for querying design state, generating reports, and inspecting timing. " +
        "Commands that modify design state are blocked — use interactive_openroad_exec instead.",
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
        "output files. Read-only commands are blocked — use interactive_openroad_query instead.",
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
      description: "Read a report image and return base64-encoded data with metadata.",
      inputSchema: {
        platform: z.string(),
        design: z.string(),
        run_slug: z.string(),
        image_name: z.string(),
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
        await readReportImageTool.execute(
          args.platform,
          args.design,
          args.run_slug,
          args.image_name,
        ),
      ),
  );

  return mcp;
}

// Module-level server instance for the production entrypoint. Tests build their
// own isolated server via createMcpServer().
export const mcp = createMcpServer();

/** Terminate every live session so shutdown does not leak OpenROAD processes. */
export async function shutdownOpenroad(): Promise<void> {
  logger.info("Initiating graceful shutdown...");
  try {
    await defaultManager.cleanupAll();
    logger.info("Graceful shutdown complete");
  } catch (e) {
    logger.error(`Error during shutdown: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Collect a request body and JSON-parse it, rejecting malformed payloads. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return undefined;
  return JSON.parse(raw);
}

/**
 * Boot the MCP server for the configured transport and block until shutdown.
 *
 * stdio is the primary npx path. http uses a stateless streamable-HTTP
 * transport — session continuity is provided by OpenROADManager keying on its
 * own session_id, so no MCP-level session state is needed. Either way the
 * lifecycle ends on a signal (SIGTERM/SIGINT) or transport close, after which
 * every session is cleaned up.
 */
export async function runServer(config: CLIConfig): Promise<void> {
  cleanupManager.registerAsyncCleanupHandler(shutdownOpenroad);
  cleanupManager.setupSignalHandlers();

  try {
    if (config.transport.mode === "stdio") {
      // A client disconnect / stdin EOF closes the transport; treat that as a
      // shutdown so the process does not hang waiting for a signal.
      mcp.server.onclose = (): void => cleanupManager.triggerShutdown();
      const transport = new StdioServerTransport();
      await mcp.connect(transport);
      logger.info("MCP server running on stdio transport");
      await cleanupManager.waitForShutdown();
    } else {
      // Omitting sessionIdGenerator selects stateless mode (no MCP session
      // tracking); OpenROADManager owns session continuity via its session_id.
      const transport = new StreamableHTTPServerTransport();
      // The SDK's streamable-HTTP transport types its onclose as
      // `(() => void) | undefined`, which trips exactOptionalPropertyTypes
      // against the Transport interface; the runtime contract is unaffected.
      await mcp.connect(transport as unknown as Parameters<typeof mcp.connect>[0]);

      const httpServer = createServer((req: IncomingMessage, res: ServerResponse): void => {
        void (async (): Promise<void> => {
          try {
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
        })();
      });

      httpServer.listen(config.transport.port, config.transport.host);
      logger.info(
        `MCP server running on http transport at ${config.transport.host}:${config.transport.port}`,
      );
      await cleanupManager.waitForShutdown();
      await new Promise<void>((resolve) => httpServer.close(() => { resolve(); }));
    }
  } finally {
    await cleanupManager.runHandlers();
  }
}
