"""Main MCP server setup and tool registration."""

import asyncio

from fastmcp import FastMCP
from mcp.types import ToolAnnotations

from openroad_mcp.config.cli import CLIConfig

from .core.manager import OpenROADManager
from .tools.interactive import (
    CreateSessionTool,
    ExecShellTool,
    InspectSessionTool,
    ListSessionsTool,
    QueryShellTool,
    SessionHistoryTool,
    SessionMetricsTool,
    TerminateSessionTool,
)
from .tools.report_images import ListReportImagesTool, ReadReportImageTool
from .utils.cleanup import cleanup_manager
from .utils.logging import get_logger

logger = get_logger("server")

# Initialize FastMCP
mcp: FastMCP = FastMCP("openroad-mcp")

# Global manager instance
manager = OpenROADManager()

# Initialize interactive tool instances
query_shell_tool = QueryShellTool(manager)
exec_shell_tool = ExecShellTool(manager)
list_sessions_tool = ListSessionsTool(manager)
create_session_tool = CreateSessionTool(manager)
terminate_session_tool = TerminateSessionTool(manager)
inspect_session_tool = InspectSessionTool(manager)
session_history_tool = SessionHistoryTool(manager)
session_metrics_tool = SessionMetricsTool(manager)

# Initialize report image tool instances
list_report_images_tool = ListReportImagesTool(manager)
read_report_image_tool = ReadReportImageTool(manager)


# Interactive session tools
@mcp.tool(
    annotations=ToolAnnotations(
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=False,
        openWorldHint=False,
    )
)
async def interactive_openroad_query(
    command: str,
    session_id: str | None = None,
    timeout_ms: int | None = None,
) -> str:
    """Execute a read-only OpenROAD command (report_*, get_*, check_*, sta, help, etc.).

    Use this for querying design state, generating reports, and inspecting timing.
    Commands that modify design state are blocked — use interactive_openroad_exec instead.
    """
    return await query_shell_tool.execute(command, session_id, timeout_ms)


@mcp.tool(
    annotations=ToolAnnotations(
        readOnlyHint=False,
        destructiveHint=True,
        idempotentHint=False,
        openWorldHint=False,
    )
)
async def interactive_openroad_exec(
    command: str,
    session_id: str | None = None,
    timeout_ms: int | None = None,
) -> str:
    """Execute a state-modifying OpenROAD command (set_*, create_*, read_*, write_*, flow commands).

    Use this for loading designs, running placement/routing, applying constraints,
    and writing output files. Read-only commands are blocked — use interactive_openroad_query instead.
    """
    return await exec_shell_tool.execute(command, session_id, timeout_ms)


@mcp.tool(
    annotations=ToolAnnotations(
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=False,
    )
)
async def list_interactive_sessions() -> str:
    """List all active interactive OpenROAD sessions."""
    return await list_sessions_tool.execute()


@mcp.tool(
    annotations=ToolAnnotations(
        readOnlyHint=False,
        destructiveHint=False,
        idempotentHint=False,
        openWorldHint=False,
    )
)
async def create_interactive_session(
    session_id: str | None = None,
    command: list[str] | None = None,
    env: dict[str, str] | None = None,
    cwd: str | None = None,
) -> str:
    """Create a new interactive OpenROAD session."""
    return await create_session_tool.execute(session_id, command, env, cwd)


@mcp.tool(
    annotations=ToolAnnotations(
        readOnlyHint=False,
        destructiveHint=True,
        idempotentHint=True,
        openWorldHint=False,
    )
)
async def terminate_interactive_session(session_id: str, force: bool = False) -> str:
    """Terminate an interactive OpenROAD session."""
    return await terminate_session_tool.execute(session_id, force)


@mcp.tool(
    annotations=ToolAnnotations(
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=False,
    )
)
async def inspect_interactive_session(session_id: str) -> str:
    """Get detailed inspection data for an interactive OpenROAD session."""
    return await inspect_session_tool.execute(session_id)


@mcp.tool(
    annotations=ToolAnnotations(
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=False,
    )
)
async def get_session_history(session_id: str, limit: int | None = None, search: str | None = None) -> str:
    """Get command history for an interactive OpenROAD session."""
    return await session_history_tool.execute(session_id, limit, search)


@mcp.tool(
    annotations=ToolAnnotations(
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=False,
    )
)
async def get_session_metrics() -> str:
    """Get comprehensive metrics for all interactive OpenROAD sessions."""
    return await session_metrics_tool.execute()


# Report image tools
@mcp.tool(
    annotations=ToolAnnotations(
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=False,
    )
)
async def list_report_images(platform: str, design: str, run_slug: str, stage: str = "all") -> str:
    """List available report images from ORFS runs organized by stage."""
    return await list_report_images_tool.execute(platform, design, run_slug, stage)


@mcp.tool(
    annotations=ToolAnnotations(
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=False,
    )
)
async def read_report_image(platform: str, design: str, run_slug: str, image_name: str) -> str:
    """Read a report image and return base64-encoded data with metadata."""
    return await read_report_image_tool.execute(platform, design, run_slug, image_name)


async def shutdown_openroad() -> None:
    """Gracefully shutdown interactive OpenROAD sessions."""
    try:
        logger.info("Initiating graceful shutdown of OpenROAD services...")

        await manager.cleanup_all()

        logger.info("OpenROAD services shutdown completed successfully")
    except Exception:
        logger.exception("Error during OpenROAD shutdown")


async def run_server(config: CLIConfig) -> None:
    """Main server entry point with lifecycle management."""
    logger.info(f"Starting OpenROAD MCP server in {config.transport.mode} mode...")

    # Create shutdown event for coordinated shutdown
    shutdown_event = asyncio.Event()

    try:
        # Register cleanup handlers
        cleanup_manager.register_async_cleanup_handler(shutdown_openroad)
        cleanup_manager.setup_signal_handlers()
        cleanup_manager.set_shutdown_event(shutdown_event)

        # Run the MCP server with the configured transport in a task
        if config.transport.mode == "stdio":
            logger.info("Using stdio transport")
            server_task = asyncio.create_task(mcp.run_async(transport="stdio"))
        elif config.transport.mode == "http":
            logger.info(f"Using HTTP transport on {config.transport.host}:{config.transport.port}")

            server_task = asyncio.create_task(
                mcp.run_async(
                    transport="http",
                    host=config.transport.host,
                    port=config.transport.port,
                )
            )
        else:
            raise ValueError(f"Unsupported transport mode: {config.transport.mode}")

        # Wait for either server completion or shutdown signal
        shutdown_task = asyncio.create_task(cleanup_manager.wait_for_shutdown())
        _, pending = await asyncio.wait([server_task, shutdown_task], return_when=asyncio.FIRST_COMPLETED)

        # Cancel pending tasks
        for task in pending:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    except KeyboardInterrupt:
        logger.info("Received keyboard interrupt")
    except Exception as e:
        logger.error(f"Unexpected error in server: {e}")
        raise
    finally:
        # Ensure cleanup happens
        await shutdown_openroad()
        logger.info("OpenROAD MCP server shutdown complete")
