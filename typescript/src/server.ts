import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { manager as defaultManager } from "./core/manager.js";
import type { OpenROADManager } from "./core/manager.js";
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
