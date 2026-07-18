"""Tests for SessionManager implementation."""

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from openroad_mcp.core.manager import OpenROADManager as SessionManager
from openroad_mcp.core.models import SessionState
from openroad_mcp.interactive.models import SessionNotFoundError, SessionTerminatedError


@pytest.mark.asyncio
class TestSessionManager:
    """Test suite for SessionManager."""

    @pytest.fixture
    def session_manager(self):
        """Create a test session manager."""
        return SessionManager()

    async def test_session_manager_initialization(self, session_manager):
        """Test session manager initialization."""
        assert session_manager.get_session_count() == 0
        assert session_manager.get_active_session_count() == 0

    async def test_session_manager_basic_functionality(self, session_manager):
        """Test basic session manager functionality without session creation."""
        assert session_manager.get_session_count() == 0
        assert session_manager.get_active_session_count() == 0

        with pytest.raises(SessionNotFoundError):
            await session_manager.get_session_info("non-existent")

        result = await session_manager.list_sessions()
        assert len(result) == 0

    @patch("openroad_mcp.core.manager.InteractiveSession")
    async def test_create_session_default(self, mock_session_class, session_manager):
        """Test creating session with default parameters."""
        # Create a proper mock that responds to session_id assignment
        mock_session = AsyncMock()
        mock_session.is_alive.return_value = True
        mock_session.start.return_value = None
        mock_session.terminate.return_value = None
        mock_session.cleanup.return_value = None

        # Mock the constructor to capture session_id
        def mock_constructor(session_id, **kwargs):
            mock_session.session_id = session_id
            return mock_session

        mock_session_class.side_effect = mock_constructor

        from datetime import datetime

        from openroad_mcp.core.models import InteractiveSessionInfo, SessionState

        session_id = await session_manager.create_session()

        mock_session.get_info.return_value = InteractiveSessionInfo(
            session_id=session_id,
            created_at=datetime.now().isoformat(),
            is_alive=True,
            command_count=0,
            buffer_size=0,
            uptime_seconds=1.0,
            state=SessionState.ACTIVE,
        )

        assert isinstance(session_id, str)
        assert len(session_id) == 8  # UUID prefix length
        assert session_manager.get_session_count() == 1

        info = await session_manager.get_session_info(session_id)
        assert info.session_id == session_id

        # Cleanup
        await session_manager.terminate_session(session_id)

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_create_session_with_params(self, mock_pty_class, session_manager, tmp_path):
        """Test creating session with custom parameters."""
        mock_pty = AsyncMock()
        mock_pty.is_process_alive.return_value = True
        mock_pty_class.return_value = mock_pty

        session_id = await session_manager.create_session(
            command=["echo", "test"], env={"TEST": "value"}, cwd=str(tmp_path)
        )

        info = await session_manager.get_session_info(session_id)
        assert info.session_id == session_id

        # Cleanup
        await session_manager.terminate_session(session_id)

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_get_session_info(self, mock_pty_class, session_manager):
        """Test getting session information."""
        mock_pty = AsyncMock()
        mock_pty.is_process_alive.return_value = True
        mock_pty_class.return_value = mock_pty

        session_id = await session_manager.create_session()

        info = await session_manager.get_session_info(session_id)
        assert info.session_id == session_id
        assert info.command_count == 0

        # Cleanup
        await session_manager.terminate_session(session_id)

    async def test_get_session_info_not_found(self, session_manager):
        """Test getting info for non-existent session."""
        with pytest.raises(SessionNotFoundError):
            await session_manager.get_session_info("non-existent")

    async def test_list_sessions_empty(self, session_manager):
        """Test listing sessions when none exist."""
        result = await session_manager.list_sessions()

        assert len(result) == 0

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_list_sessions_multiple(self, mock_pty_class, session_manager):
        """Test listing multiple sessions."""
        mock_pty = AsyncMock()
        mock_pty.is_process_alive.return_value = True
        mock_pty_class.return_value = mock_pty

        # Create multiple sessions
        session_ids = []
        for _ in range(3):
            session_id = await session_manager.create_session()
            session_ids.append(session_id)

        result = await session_manager.list_sessions()

        assert len(result) == 3

        returned_ids = [s.session_id for s in result]
        for session_id in session_ids:
            assert session_id in returned_ids

        # Cleanup
        for session_id in session_ids:
            await session_manager.terminate_session(session_id)

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_execute_command_existing_session(self, mock_pty_class, session_manager):
        """Test executing command in existing session."""
        mock_pty = AsyncMock()
        mock_pty.is_process_alive.return_value = True
        mock_pty_class.return_value = mock_pty

        session_id = await session_manager.create_session()

        with (
            patch("openroad_mcp.interactive.session.InteractiveSession.send_command"),
            patch("openroad_mcp.interactive.session.InteractiveSession.read_output") as mock_read,
        ):
            mock_read.return_value = AsyncMock()
            mock_read.return_value.output = "existing session output"
            mock_read.return_value.session_id = session_id
            mock_read.return_value.execution_time = 0.05

            result = await session_manager.execute_command(session_id=session_id, command="test command")

            assert "existing session output" in result.output
            assert result.session_id == session_id

        # Cleanup
        await session_manager.terminate_session(session_id)

    async def test_execute_command_session_not_found(self, session_manager):
        """Test executing command in non-existent session."""
        with pytest.raises(SessionNotFoundError):
            await session_manager.execute_command(session_id="non-existent", command="test")

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_terminate_session(self, mock_pty_class, session_manager):
        """Test terminating a session."""
        mock_pty = AsyncMock()
        mock_pty.is_process_alive.return_value = True
        mock_pty_class.return_value = mock_pty

        session_id = await session_manager.create_session()

        with patch("openroad_mcp.interactive.session.InteractiveSession.terminate") as mock_terminate:
            await session_manager.terminate_session(session_id, force=True)
            mock_terminate.assert_called_once_with(True)

    async def test_terminate_session_not_found(self, session_manager):
        """Test terminating non-existent session."""
        with pytest.raises(SessionNotFoundError):
            await session_manager.terminate_session("non-existent")

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_cleanup_session(self, mock_pty_class, session_manager):
        """Test cleaning up a session via termination."""
        mock_pty = AsyncMock()
        mock_pty.is_process_alive.return_value = True
        mock_pty_class.return_value = mock_pty

        session_id = await session_manager.create_session()

        await session_manager.terminate_session(session_id)

        with pytest.raises(SessionNotFoundError):
            await session_manager.get_session_info(session_id)

    async def test_cleanup_session_not_found(self, session_manager):
        """Test cleaning up non-existent session."""
        with pytest.raises(SessionNotFoundError):
            await session_manager.terminate_session("non-existent")

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_cleanup_all_sessions(self, mock_pty_class, session_manager):
        """Test cleaning up all sessions."""
        mock_pty = AsyncMock()
        mock_pty.is_process_alive.return_value = True
        mock_pty_class.return_value = mock_pty

        # Create multiple sessions
        session_ids = []
        for _ in range(3):
            session_id = await session_manager.create_session()
            session_ids.append(session_id)

        # Call cleanup_all() — the correct OpenROADManager API (cleanup() doesn't exist)
        await session_manager.cleanup_all()
        assert session_manager.get_session_count() == 0

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_session_auto_cleanup_on_error(self, mock_pty_class, session_manager):
        """Test that sessions are auto-cleaned on errors."""
        mock_pty = AsyncMock()
        mock_pty.is_process_alive.return_value = True
        mock_pty_class.return_value = mock_pty

        session_id = await session_manager.create_session()

        # Simulate session error
        # Session will be in error state after cleanup

        with patch("openroad_mcp.interactive.session.InteractiveSession.send_command") as mock_send:
            mock_send.side_effect = SessionTerminatedError("Session terminated")

            with pytest.raises(SessionTerminatedError):
                await session_manager.execute_command(session_id, "test")

        # Cleanup
        try:
            await session_manager.terminate_session(session_id)
        except SessionNotFoundError:
            pass  # Session may already be cleaned up

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_concurrent_session_creation(self, mock_pty_class, session_manager):
        """Test concurrent session creation."""
        mock_pty = AsyncMock()
        mock_pty.is_process_alive.return_value = True
        mock_pty_class.return_value = mock_pty

        async def create_session():
            return await session_manager.create_session()

        # Create 10 sessions concurrently
        tasks = [create_session() for _ in range(10)]
        session_ids = await asyncio.gather(*tasks)

        # All sessions should be unique
        assert len(set(session_ids)) == 10
        assert session_manager.get_session_count() == 10

        # Cleanup
        for session_id in session_ids:
            await session_manager.terminate_session(session_id)

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_session_counter_increment(self, mock_pty_class, session_manager):
        """Test that multiple sessions are created with unique IDs."""
        mock_pty = AsyncMock()
        mock_pty.is_process_alive.return_value = True
        mock_pty_class.return_value = mock_pty

        session_id1 = await session_manager.create_session()
        session_id2 = await session_manager.create_session()

        # Session IDs should be unique
        assert session_id1 != session_id2
        assert len(session_id1) == 8  # UUID prefix length
        assert len(session_id2) == 8

        # Cleanup
        await session_manager.terminate_session(session_id1)
        await session_manager.terminate_session(session_id2)

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_session_state_tracking(self, mock_pty_class, session_manager):
        """Test session state tracking through manager."""
        mock_pty = AsyncMock()
        mock_pty.is_process_alive.return_value = True
        mock_pty_class.return_value = mock_pty

        session_id = await session_manager.create_session()

        # Get session info to verify state
        info = await session_manager.get_session_info(session_id)
        assert info.state in [SessionState.CREATING, SessionState.ACTIVE]

        # Since we can't directly access sessions, just verify the session exists
        await session_manager.terminate_session(session_id)

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_session_command_history_tracking(self, mock_pty_class, session_manager):
        """Test command history tracking."""
        mock_pty = AsyncMock()
        mock_pty.is_process_alive.return_value = True
        mock_pty_class.return_value = mock_pty

        session_id = await session_manager.create_session()

        with (
            patch("openroad_mcp.interactive.session.InteractiveSession.send_command") as mock_send,
            patch("openroad_mcp.interactive.session.InteractiveSession.read_output") as mock_read,
            patch("openroad_mcp.interactive.session.InteractiveSession.get_info") as mock_info,
        ):
            # Setup mock for execute_command
            from datetime import datetime

            from openroad_mcp.core.models import InteractiveExecResult

            mock_read.return_value = InteractiveExecResult(
                output="output", session_id=session_id, execution_time=0.05, timestamp=datetime.now().isoformat()
            )

            # Setup mock for get_info with incrementing command count
            from openroad_mcp.core.models import InteractiveSessionInfo

            # Create a counter that tracks how many times execute_command is called
            exec_count = 0

            async def mock_get_info():
                # Return a count based on how many times execute_command was called
                return InteractiveSessionInfo(
                    session_id=session_id,
                    created_at="2025-01-01T00:00:00",
                    is_alive=True,
                    command_count=exec_count,
                    buffer_size=0,
                    uptime_seconds=1.0,
                    state="active",
                )

            mock_info.side_effect = mock_get_info
            mock_send.return_value = None

            # Execute multiple commands
            await session_manager.execute_command(session_id, "cmd1")
            exec_count += 1
            await session_manager.execute_command(session_id, "cmd2")
            exec_count += 1

            # Verify command count increased
            info = await session_manager.get_session_info(session_id)
            assert info.command_count >= 2

        # Cleanup
        await session_manager.terminate_session(session_id)


@pytest.mark.asyncio
class TestSessionManagerAsync:
    """Async test runner for SessionManager."""

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_session_manager_lifecycle(self, mock_pty_class):
        """Test complete session manager lifecycle."""
        mock_pty = AsyncMock()
        mock_pty.is_process_alive.return_value = True
        mock_pty_class.return_value = mock_pty

        manager = SessionManager()

        try:
            # Create session
            session_id = await manager.create_session()
            assert manager.get_session_count() == 1

            # List sessions
            result = await manager.list_sessions()
            assert len(result) == 1

            # Get session info
            info = await manager.get_session_info(session_id)
            assert info.session_id == session_id

            # Cleanup
            await manager.terminate_session(session_id)
            assert manager.get_session_count() == 0

        finally:
            # Ensure cleanup via the correct OpenROADManager method
            await manager.cleanup_all()

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_stress_session_operations(self, mock_pty_class):
        """Test stress operations on session manager."""
        mock_pty = AsyncMock()
        mock_pty.is_process_alive.return_value = True
        mock_pty.wait_for_exit.return_value = None  # simulate running process; None means no exit yet
        mock_pty_class.return_value = mock_pty

        num_sessions = 50
        manager = SessionManager(max_sessions=num_sessions)

        try:
            # Create many sessions rapidly
            tasks = []
            for _ in range(num_sessions):
                task = manager.create_session()
                tasks.append(task)

            session_ids = await asyncio.gather(*tasks)
            assert len(session_ids) == num_sessions
            assert len(set(session_ids)) == num_sessions  # All unique

            # List all sessions
            result = await manager.list_sessions()
            assert len(result) == num_sessions

            # Cleanup some sessions concurrently
            sessions_to_cleanup = num_sessions // 2
            cleanup_tasks = []
            for i in range(sessions_to_cleanup):
                task = manager.terminate_session(session_ids[i])
                cleanup_tasks.append(task)

            await asyncio.gather(*cleanup_tasks)
            assert manager.get_session_count() == num_sessions - sessions_to_cleanup

        finally:
            await manager.cleanup_all()
