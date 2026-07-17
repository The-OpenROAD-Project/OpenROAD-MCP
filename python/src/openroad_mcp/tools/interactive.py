"""Interactive shell tools for OpenROAD MCP server."""

import json
from collections.abc import Callable
from datetime import datetime

from ..config.command_whitelist import is_exec_command, is_query_command
from ..config.settings import settings
from ..core.models import (
    InteractiveExecResult,
    InteractiveSessionInfo,
    InteractiveSessionListResult,
    SessionHistoryResult,
    SessionInspectionResult,
    SessionMetricsResult,
    SessionTerminationResult,
)
from ..interactive.models import SessionError, SessionNotFoundError, SessionTerminatedError
from ..utils.logging import get_logger
from .base import BaseTool

logger = get_logger("interactive_tools")


def _session_not_found_exec_result(session_id: str | None, error: Exception) -> InteractiveExecResult:
    return InteractiveExecResult(
        output=f"Error: Session '{session_id}' not found.",
        session_id=session_id,
        timestamp=datetime.now().isoformat(),
        execution_time=0.0,
        error=str(error),
    )


def _blocked_error(command: str, blocked_verb: str, session_id: str | None) -> str:
    """Return a hard-block error result for a disallowed command."""
    result = InteractiveExecResult(
        output=f"Command blocked: '{blocked_verb}' is not on the OpenROAD allowlist.\nFull command: {command!r}",
        session_id=session_id,
        timestamp=datetime.now().isoformat(),
        execution_time=0.0,
        error=f"CommandBlocked: '{blocked_verb}'",
    )
    return json.dumps(result.model_dump(), separators=(",", ":"), default=str)


def _apply_whitelist(
    command: str,
    validator: Callable[[str], tuple[bool, str | None]],
    session_id: str | None,
) -> str | None:
    """Return a blocked-error string if the command is disallowed, else None."""
    if not settings.WHITELIST_ENABLED:
        return None
    allowed, blocked_verb = validator(command)
    if not allowed:
        logger.warning("Blocked command '%s' in session %s", blocked_verb, session_id)
        return _blocked_error(command, blocked_verb or command.split()[0], session_id)
    return None


class QueryShellTool(BaseTool):
    """Tool for executing read-only queries in interactive OpenROAD sessions.

    Only READONLY_PATTERNS commands are permitted (report_*, get_*, check_*,
    sta, estimate_parasitics, help, version, and safe Tcl built-ins).
    """

    async def execute(
        self,
        command: str,
        session_id: str | None = None,
        timeout_ms: int | None = None,
    ) -> str:
        """Execute a read-only command in an interactive OpenROAD session."""
        if blocked := _apply_whitelist(command, is_query_command, session_id):
            return blocked

        try:
            if session_id is None:
                session_id = await self.manager.create_session()

            result = await self.manager.execute_command(session_id, command, timeout_ms)
            return self._format_result(result)

        except SessionNotFoundError as e:
            logger.warning("Session not found: %s", session_id)
            return self._format_result(_session_not_found_exec_result(session_id, e))

        except (SessionTerminatedError, SessionError) as e:
            logger.error("Session error for %s: %s", session_id, e)
            return self._format_result(
                InteractiveExecResult(
                    output=f"Session Error: {str(e)}.",
                    session_id=session_id,
                    timestamp=datetime.now().isoformat(),
                    execution_time=0.0,
                    error=str(e),
                )
            )

        except Exception as e:
            logger.exception("Unexpected error executing command in session %s", session_id)
            return self._format_result(
                InteractiveExecResult(
                    output=f"Unexpected error: {str(e)}.",
                    session_id=session_id,
                    timestamp=datetime.now().isoformat(),
                    execution_time=0.0,
                    error=str(e),
                )
            )


class ExecShellTool(BaseTool):
    """Tool for executing state-modifying commands in interactive OpenROAD sessions.

    Only MODIFY_PATTERNS commands are permitted (set_*, create_*, read_*, write_*,
    flow/repair commands, and safe Tcl built-ins).
    """

    async def execute(
        self,
        command: str,
        session_id: str | None = None,
        timeout_ms: int | None = None,
    ) -> str:
        """Execute a modifying command in an interactive OpenROAD session."""
        if blocked := _apply_whitelist(command, is_exec_command, session_id):
            return blocked

        try:
            if session_id is None:
                session_id = await self.manager.create_session()

            result = await self.manager.execute_command(session_id, command, timeout_ms)
            return self._format_result(result)

        except SessionNotFoundError as e:
            logger.warning("Session not found: %s", session_id)
            return self._format_result(_session_not_found_exec_result(session_id, e))

        except (SessionTerminatedError, SessionError) as e:
            logger.error("Session error for %s: %s", session_id, e)
            return self._format_result(
                InteractiveExecResult(
                    output=f"Session Error: {str(e)}.",
                    session_id=session_id,
                    timestamp=datetime.now().isoformat(),
                    execution_time=0.0,
                    error=str(e),
                )
            )

        except Exception as e:
            logger.exception("Unexpected error executing command in session %s", session_id)
            return self._format_result(
                InteractiveExecResult(
                    output=f"Unexpected error: {str(e)}.",
                    session_id=session_id,
                    timestamp=datetime.now().isoformat(),
                    execution_time=0.0,
                    error=str(e),
                )
            )


# Keep InteractiveShellTool as an alias for backward compatibility with existing tests.
InteractiveShellTool = QueryShellTool


class ListSessionsTool(BaseTool):
    """Tool for listing interactive sessions."""

    async def execute(self) -> str:
        """List all interactive sessions."""
        try:
            sessions = await self.manager.list_sessions()

            active_count = sum(1 for session in sessions if session.is_alive)

            result = InteractiveSessionListResult(
                sessions=sessions, total_count=len(sessions), active_count=active_count
            )

            return self._format_result(result)

        except Exception as e:
            logger.exception("Failed to list interactive sessions")
            return self._format_result(
                InteractiveSessionListResult(
                    sessions=[],
                    total_count=0,
                    active_count=0,
                    error=f"Failed to list sessions: {str(e)}",
                )
            )


class CreateSessionTool(BaseTool):
    """Tool for creating new interactive sessions."""

    async def execute(
        self,
        session_id: str | None = None,
        command: list[str] | None = None,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
    ) -> str:
        """Create a new interactive session."""
        try:
            created_session_id = await self.manager.create_session(session_id, command, env, cwd)

            session_info = await self.manager.get_session_info(created_session_id)

            return self._format_result(session_info)

        except SessionError as e:
            logger.error("Session creation error: %s", e)
            return self._format_result(
                InteractiveSessionInfo(
                    session_id=session_id or "failed",
                    created_at=datetime.now().isoformat(),
                    is_alive=False,
                    command_count=0,
                    buffer_size=0,
                    error=str(e),
                )
            )

        except Exception as e:
            logger.exception("Unexpected error creating session %s", session_id)
            return self._format_result(
                InteractiveSessionInfo(
                    session_id=session_id or "failed",
                    created_at=datetime.now().isoformat(),
                    is_alive=False,
                    command_count=0,
                    buffer_size=0,
                    error=f"Unexpected error: {str(e)}",
                )
            )


class TerminateSessionTool(BaseTool):
    """Tool for terminating interactive sessions."""

    async def execute(self, session_id: str, force: bool = False) -> str:
        """Terminate an interactive session."""
        try:
            try:
                session_info = await self.manager.get_session_info(session_id)
                was_alive = session_info.is_alive
            except SessionNotFoundError:
                was_alive = False

            await self.manager.terminate_session(session_id, force)

            result = SessionTerminationResult(session_id=session_id, terminated=True, was_alive=was_alive, force=force)

            return self._format_result(result)

        except SessionNotFoundError as e:
            logger.warning("Attempted to terminate non-existent session: %s", session_id)
            return self._format_result(
                SessionTerminationResult(
                    session_id=session_id,
                    terminated=False,
                    error=f"Session not found: {str(e)}",
                    force=force,
                )
            )

        except Exception as e:
            logger.exception("Failed to terminate session %s", session_id)
            return self._format_result(
                SessionTerminationResult(
                    session_id=session_id,
                    terminated=False,
                    error=f"Termination failed: {str(e)}",
                    force=force,
                )
            )


class InspectSessionTool(BaseTool):
    """Tool for detailed session introspection."""

    async def execute(self, session_id: str) -> str:
        """Get detailed session inspection data."""
        try:
            metrics = await self.manager.inspect_session(session_id)
            return self._format_result(SessionInspectionResult(session_id=session_id, metrics=metrics))

        except SessionNotFoundError as e:
            logger.warning("Attempted to inspect non-existent session: %s", session_id)
            return self._format_result(
                SessionInspectionResult(
                    session_id=session_id,
                    error=f"Session not found: {str(e)}",
                    metrics=None,
                )
            )

        except Exception as e:
            logger.exception("Failed to inspect session %s", session_id)
            return self._format_result(
                SessionInspectionResult(
                    session_id=session_id,
                    error=f"Inspection failed: {str(e)}",
                    metrics=None,
                )
            )


class SessionHistoryTool(BaseTool):
    """Tool for retrieving session command history."""

    async def execute(self, session_id: str, limit: int | None = None, search: str | None = None) -> str:
        """Get command history for a session."""
        try:
            history = await self.manager.get_session_history(session_id, limit, search)

            result = SessionHistoryResult(
                session_id=session_id,
                history=history,
                total_commands=len(history),
                limit=limit,
                search=search,
            )
            return self._format_result(result)

        except SessionNotFoundError as e:
            logger.warning("Attempted to get history for non-existent session: %s", session_id)
            return self._format_result(
                SessionHistoryResult(
                    session_id=session_id,
                    history=[],
                    total_commands=0,
                    limit=limit,
                    search=search,
                    error=f"Session not found: {str(e)}",
                )
            )

        except Exception as e:
            logger.exception("Failed to get history for session %s", session_id)
            return self._format_result(
                SessionHistoryResult(
                    session_id=session_id,
                    history=[],
                    total_commands=0,
                    limit=limit,
                    search=search,
                    error=f"History retrieval failed: {str(e)}",
                )
            )


class SessionMetricsTool(BaseTool):
    """Tool for retrieving comprehensive session metrics."""

    async def execute(self) -> str:
        """Get comprehensive metrics for all sessions."""
        try:
            metrics = await self.manager.session_metrics()
            return self._format_result(SessionMetricsResult(metrics=metrics))

        except Exception as e:
            logger.exception("Failed to get session metrics")
            return self._format_result(
                SessionMetricsResult(
                    metrics=None,
                    error=f"Metrics retrieval failed: {str(e)}",
                )
            )
