"""Tests for Interactive MCP Tools implementation."""

import asyncio
from unittest.mock import AsyncMock

import pytest

from openroad_mcp.core.models import InteractiveExecResult
from openroad_mcp.interactive.models import SessionNotFoundError, SessionTerminatedError
from openroad_mcp.tools.interactive import (
    CreateSessionTool,
    InspectSessionTool,
    InteractiveShellTool,
    ListSessionsTool,
    TerminateSessionTool,
)


@pytest.mark.asyncio
class TestInteractiveShellTool:
    """Test suite for InteractiveShellTool."""

    @pytest.fixture
    def mock_manager(self):
        """Create a mock OpenROADManager."""
        return AsyncMock()

    @pytest.fixture
    def tool(self, mock_manager):
        """Create InteractiveShellTool with mock manager."""
        return InteractiveShellTool(mock_manager)

    async def test_execute_with_new_session(self, tool, mock_manager):
        """Test executing command with automatic session creation."""
        # Setup mocks
        mock_manager.create_session.return_value = "session-1"
        mock_result = InteractiveExecResult(
            output="test output",
            session_id="session-1",
            timestamp="2024-01-01T00:00:00Z",
            execution_time=0.1,
            command_count=1,
        )
        mock_manager.execute_command.return_value = mock_result

        # Execute command
        result_json = await tool.execute("report_wns")

        # Verify session creation and execution
        mock_manager.create_session.assert_called_once()
        mock_manager.execute_command.assert_called_once_with("session-1", "report_wns", None)

        # Verify result format
        assert "test output" in result_json
        assert "session-1" in result_json

    async def test_execute_with_existing_session(self, tool, mock_manager):
        """Test executing command in existing session."""
        # Setup mock
        mock_result = InteractiveExecResult(
            output="existing session output",
            session_id="existing-session",
            timestamp="2024-01-01T00:00:00Z",
            execution_time=0.05,
            command_count=5,
        )
        mock_manager.execute_command.return_value = mock_result

        # Execute command
        await tool.execute("report_checks -path_delay max", session_id="existing-session", timeout_ms=5000)

        # Verify no session creation
        mock_manager.create_session.assert_not_called()
        mock_manager.execute_command.assert_called_once_with("existing-session", "report_checks -path_delay max", 5000)

    async def test_execute_session_not_found_error(self, tool, mock_manager):
        """Test handling session not found error."""
        # Setup mock to raise error
        mock_manager.execute_command.side_effect = SessionNotFoundError("Session not found")

        # Execute command
        result_json = await tool.execute("report_wns", session_id="non-existent")

        # Verify error handling
        assert "Session not found" in result_json
        assert "non-existent" in result_json

    async def test_execute_session_terminated_error(self, tool, mock_manager):
        """Test handling session terminated error."""
        # Setup mock to raise error
        mock_manager.execute_command.side_effect = SessionTerminatedError("Session terminated")

        # Execute command
        result_json = await tool.execute("report_wns", session_id="terminated-session")

        # Verify error handling
        assert "Session Error: Session terminated" in result_json

    async def test_execute_unexpected_error(self, tool, mock_manager):
        """Test handling unexpected errors."""
        # Setup mock to raise error
        mock_manager.execute_command.side_effect = ValueError("Unexpected error")

        # Execute command
        result_json = await tool.execute("report_wns", session_id="some-session")

        # Verify error handling
        assert "Unexpected error" in result_json


class TestCreateSessionTool:
    """Test suite for CreateSessionTool."""

    @pytest.fixture
    def mock_manager(self):
        """Create a mock OpenROADManager."""
        return AsyncMock()

    @pytest.fixture
    def tool(self, mock_manager):
        """Create CreateSessionTool with mock manager."""
        return CreateSessionTool(mock_manager)

    async def test_create_session_default(self, tool, mock_manager):
        """Test creating session with default parameters."""
        # Setup mocks
        mock_manager.create_session.return_value = "session-1"

        # Create a proper InteractiveSessionInfo object instead of AsyncMock
        from openroad_mcp.core.models import InteractiveSessionInfo

        mock_session_info = InteractiveSessionInfo(
            session_id="session-1",
            created_at="2024-01-01T00:00:00Z",
            is_alive=True,
            command_count=0,
            buffer_size=1024,
            uptime_seconds=0.0,
            state="creating",
        )
        mock_manager.get_session_info.return_value = mock_session_info

        # Create session
        result_json = await tool.execute()

        # Verify session creation
        mock_manager.create_session.assert_called_once_with(None, None, None, None)
        assert "session-1" in result_json

    async def test_create_session_with_params(self, tool, mock_manager):
        """Test creating session with custom parameters."""
        # Setup mocks
        mock_manager.create_session.return_value = "custom-session"

        # Create a proper InteractiveSessionInfo object instead of AsyncMock
        from openroad_mcp.core.models import InteractiveSessionInfo

        mock_session_info = InteractiveSessionInfo(
            session_id="custom-session",
            created_at="2024-01-01T00:00:00Z",
            is_alive=True,
            command_count=0,
            buffer_size=4096,
            uptime_seconds=0.0,
            state="creating",
        )
        mock_manager.get_session_info.return_value = mock_session_info

        # Create session with parameters
        result_json = await tool.execute(command=["openroad", "-v"], env={"DEBUG": "1"}, cwd="/workspace")

        # Verify session creation with parameters
        mock_manager.create_session.assert_called_once_with(None, ["openroad", "-v"], {"DEBUG": "1"}, "/workspace")
        assert "custom-session" in result_json

    async def test_create_session_error(self, tool, mock_manager):
        """Test handling session creation error."""
        # Setup mock to raise error
        mock_manager.create_session.side_effect = Exception("Creation failed")

        # Create session
        result_json = await tool.execute()

        # Verify error handling
        assert "Creation failed" in result_json


class TestInspectSessionTool:
    """Test suite for InspectSessionTool."""

    @pytest.fixture
    def mock_manager(self):
        """Create a mock OpenROADManager."""
        return AsyncMock()

    @pytest.fixture
    def tool(self, mock_manager):
        """Create InspectSessionTool with mock manager."""
        return InspectSessionTool(mock_manager)

    async def test_inspect_session(self, tool, mock_manager):
        """Test session inspection."""
        # Setup mock
        mock_metrics = {
            "session_id": "test-session",
            "state": "active",
            "is_alive": True,
            "command_count": 10,
            "buffer_size": 1024,
            "uptime_seconds": 300.5,
            "memory_usage": {"rss_mb": 25.5, "vms_mb": 50.0},
            "performance": {"commands_per_second": 2.5},
        }
        mock_manager.inspect_session.return_value = mock_metrics

        # Inspect session
        result_json = await tool.execute("test-session")

        # Verify call
        mock_manager.inspect_session.assert_called_once_with("test-session")

        # Verify result
        assert "test-session" in result_json
        assert "active" in result_json

    async def test_inspect_session_not_found(self, tool, mock_manager):
        """Test inspecting non-existent session."""
        # Setup mock to raise error
        mock_manager.inspect_session.side_effect = SessionNotFoundError("Session not found")

        # Inspect session
        result_json = await tool.execute("non-existent")

        # Verify error handling
        assert "Session not found" in result_json

    async def test_inspect_session_unexpected_error(self, tool, mock_manager):
        """Test handling unexpected errors."""
        # Setup mock to raise error
        mock_manager.inspect_session.side_effect = Exception("Inspection error")

        # Inspect session
        result_json = await tool.execute("some-session")

        # Verify error handling
        assert "Inspection error" in result_json


class TestListSessionsTool:
    """Test suite for ListSessionsTool."""

    @pytest.fixture
    def mock_manager(self):
        """Create a mock OpenROADManager."""
        return AsyncMock()

    @pytest.fixture
    def tool(self, mock_manager):
        """Create ListSessionsTool with mock manager."""
        return ListSessionsTool(mock_manager)

    async def test_list_sessions_empty(self, tool, mock_manager):
        """Test listing sessions when none exist."""
        # Setup mock
        mock_sessions = []
        mock_manager.list_sessions.return_value = mock_sessions

        # List sessions
        result_json = await tool.execute()

        # Verify call
        mock_manager.list_sessions.assert_called_once()

        # Verify result
        assert "total_count" in result_json or "0" in result_json

    async def test_list_sessions_multiple(self, tool, mock_manager):
        """Test listing multiple sessions."""
        # Setup mock sessions with proper InteractiveSessionInfo objects
        from openroad_mcp.core.models import InteractiveSessionInfo

        session1 = InteractiveSessionInfo(
            session_id="session-1",
            created_at="2024-01-01T00:00:00Z",
            is_alive=True,
            command_count=5,
            buffer_size=1024,
            uptime_seconds=100.0,
            state="active",
        )

        session2 = InteractiveSessionInfo(
            session_id="session-2",
            created_at="2024-01-01T00:01:00Z",
            is_alive=False,
            command_count=0,
            buffer_size=2048,
            uptime_seconds=10.0,
            state="creating",
        )

        mock_sessions = [session1, session2]
        mock_manager.list_sessions.return_value = mock_sessions

        # List sessions
        result_json = await tool.execute()

        # Verify result contains both sessions
        assert "session-1" in result_json
        assert "session-2" in result_json

    async def test_list_sessions_error(self, tool, mock_manager):
        """Test handling list sessions error."""
        # Setup mock to raise error
        mock_manager.list_sessions.side_effect = Exception("List error")

        # List sessions (should handle error gracefully)
        result_json = await tool.execute()

        # Should return empty result structure rather than error
        assert "total_count" in result_json or "sessions" in result_json


class TestTerminateSessionTool:
    """Test suite for TerminateSessionTool."""

    @pytest.fixture
    def mock_manager(self):
        """Create a mock OpenROADManager."""
        return AsyncMock()

    @pytest.fixture
    def tool(self, mock_manager):
        """Create TerminateSessionTool with mock manager."""
        return TerminateSessionTool(mock_manager)

    async def test_terminate_session(self, tool, mock_manager):
        """Test terminating a session."""
        # Setup mock session info
        mock_session_info = AsyncMock()
        mock_session_info.is_alive = True
        mock_manager.get_session_info.return_value = mock_session_info

        # Terminate session
        result_json = await tool.execute("test-session", force=False)

        # Verify calls
        mock_manager.get_session_info.assert_called_once_with("test-session")
        mock_manager.terminate_session.assert_called_once_with("test-session", False)

        # Verify result
        assert "test-session" in result_json
        assert "terminated" in result_json

    async def test_terminate_session_force(self, tool, mock_manager):
        """Test force terminating a session."""
        # Setup mock session info
        mock_session_info = AsyncMock()
        mock_session_info.is_alive = True
        mock_manager.get_session_info.return_value = mock_session_info

        # Terminate session with force
        result_json = await tool.execute("test-session", force=True)

        # Verify calls
        mock_manager.terminate_session.assert_called_once_with("test-session", True)

        # Verify result
        assert "test-session" in result_json
        assert "terminated" in result_json

    async def test_terminate_session_not_found(self, tool, mock_manager):
        """Test terminating non-existent session."""
        # Setup mock to raise error on get_session_info but succeed on terminate
        mock_manager.get_session_info.side_effect = SessionNotFoundError("Session not found")
        # terminate_session just succeeds silently even for non-existent sessions

        # Terminate session
        result_json = await tool.execute("non-existent")

        # Should handle gracefully - was_alive=false, terminated=true
        assert "non-existent" in result_json
        assert "terminated" in result_json
        assert "was_alive" in result_json

    async def test_terminate_session_error(self, tool, mock_manager):
        """Test handling termination error."""
        # Setup mock session info
        mock_session_info = AsyncMock()
        mock_session_info.is_alive = True
        mock_manager.get_session_info.return_value = mock_session_info

        # Setup mock to raise error on terminate
        mock_manager.terminate_session.side_effect = Exception("Termination failed")

        # Terminate session
        result_json = await tool.execute("some-session")

        # Verify error handling
        assert "Termination failed" in result_json


@pytest.mark.asyncio
class TestInteractiveToolsIntegration:
    """Integration tests for interactive tools."""

    async def test_tool_workflow(self):
        """Test complete workflow using all interactive tools."""
        # Mock manager
        manager = AsyncMock()

        # Setup tools
        create_tool = CreateSessionTool(manager)
        shell_tool = InteractiveShellTool(manager)
        list_tool = ListSessionsTool(manager)
        terminate_tool = TerminateSessionTool(manager)

        # Mock responses
        manager.create_session.return_value = "workflow-session"

        # Create proper InteractiveSessionInfo object
        from openroad_mcp.core.models import InteractiveSessionInfo

        mock_session_info = InteractiveSessionInfo(
            session_id="workflow-session",
            created_at="2024-01-01T00:00:00Z",
            is_alive=True,
            command_count=1,
            buffer_size=1024,
            uptime_seconds=10.0,
            state="active",
        )
        manager.get_session_info.return_value = mock_session_info

        mock_exec_result = InteractiveExecResult(
            output="command executed",
            session_id="workflow-session",
            timestamp="2024-01-01T00:00:00Z",
            execution_time=0.1,
            command_count=1,
        )
        manager.execute_command.return_value = mock_exec_result

        mock_sessions = [mock_session_info]
        manager.list_sessions.return_value = mock_sessions

        # Execute workflow
        create_result = await create_tool.execute()
        assert "workflow-session" in create_result

        exec_result = await shell_tool.execute("report_wns", session_id="workflow-session")
        assert "command executed" in exec_result

        list_result = await list_tool.execute()
        assert "workflow-session" in list_result or "sessions" in list_result

        terminate_result = await terminate_tool.execute("workflow-session")
        assert "workflow-session" in terminate_result

    async def test_concurrent_tool_operations(self):
        """Test concurrent operations across tools."""
        # Mock manager
        manager = AsyncMock()

        # Setup multiple shell tools
        tools = []
        for _i in range(5):
            tool = InteractiveShellTool(manager)
            tools.append(tool)

        # Mock responses
        async def mock_create_session(*args, **kwargs):
            await asyncio.sleep(0.01)  # Simulate async work
            return f"session-{len(args)}"

        async def mock_execute_command(session_id, command, timeout_ms=None):
            await asyncio.sleep(0.01)  # Simulate async work
            return InteractiveExecResult(
                output=f"output for {command}",
                session_id=session_id,
                timestamp="2024-01-01T00:00:00Z",
                execution_time=0.01,
                command_count=1,
            )

        manager.create_session.side_effect = mock_create_session
        manager.execute_command.side_effect = mock_execute_command

        # Execute concurrent operations using valid OpenROAD commands
        commands = ["report_wns", "report_tns", "report_checks", "get_nets *", "get_cells *"]
        tasks = []
        for i, tool in enumerate(tools):
            task = tool.execute(commands[i], session_id=f"session-{i}")
            tasks.append(task)

        results = await asyncio.gather(*tasks)

        # Verify all operations completed
        assert len(results) == 5
        for _i, result in enumerate(results):
            assert "output" in result
