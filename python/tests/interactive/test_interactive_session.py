"""Tests for InteractiveSession implementation."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from openroad_mcp.core.models import SessionState
from openroad_mcp.interactive.models import SessionTerminatedError
from openroad_mcp.interactive.session import InteractiveSession


@pytest.mark.asyncio
class TestInteractiveSession:
    """Test suite for InteractiveSession."""

    @pytest.fixture
    def session(self):
        """Create a test session."""
        return InteractiveSession("test-session-1", buffer_size=1024)

    async def test_session_creation(self, session):
        """Test session creation and initial state."""
        assert session.session_id == "test-session-1"
        assert session.state == SessionState.CREATING
        assert session.command_count == 0
        assert not session.is_alive()

        # Check that components are created
        assert session.pty is not None
        assert session.output_buffer is not None
        assert session.input_queue is not None

    async def test_session_info(self, session):
        """Test session info retrieval."""
        info = await session.get_info()

        assert info.session_id == "test-session-1"
        assert info.state == SessionState.CREATING
        assert not info.is_alive
        assert info.command_count == 0
        assert info.buffer_size == 0
        assert info.uptime_seconds is not None

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_session_start_success(self, mock_pty_class, session):
        """Test successful session start."""
        # Mock PTY handler
        mock_pty = AsyncMock()
        mock_pty.is_process_alive = MagicMock(return_value=True)
        mock_pty_class.return_value = mock_pty
        session.pty = mock_pty

        # Start session
        await session.start(["echo", "test"])

        # Verify state change and PTY creation
        assert session.state == SessionState.ACTIVE
        mock_pty.create_session.assert_called_once_with(["echo", "test"], None, None)

        # Verify background tasks started
        assert session._reader_task is not None
        assert session._writer_task is not None
        assert session._exit_monitor_task is not None

        # Cleanup
        await session.cleanup()

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_session_start_failure(self, mock_pty_class, session):
        """Test session start failure handling."""
        # Mock PTY handler to raise exception
        mock_pty = AsyncMock()
        mock_pty.create_session.side_effect = Exception("PTY creation failed")
        mock_pty_class.return_value = mock_pty
        session.pty = mock_pty

        # Start session should fail
        with pytest.raises(Exception, match="Failed to start session"):
            await session.start(["fail"])

        # Verify error state
        assert session.state == SessionState.ERROR

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_send_command(self, mock_pty_class, session):
        """Test sending commands to session."""
        # Setup mock
        from unittest.mock import MagicMock

        mock_pty = MagicMock()
        mock_pty.is_process_alive = MagicMock(return_value=True)
        session.pty = mock_pty
        session.state = SessionState.ACTIVE

        # Send command
        await session.send_command("test command")

        # Verify command was queued
        assert session.command_count == 1
        assert not session.input_queue.empty()

        # Get queued data
        queued_data = await session.input_queue.get()
        assert queued_data == b"test command\n"

    async def test_send_command_to_dead_session(self, session):
        """Test sending command to terminated session."""
        session.state = SessionState.TERMINATED

        with pytest.raises(SessionTerminatedError):
            await session.send_command("test")

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_read_output_timeout(self, mock_pty_class, session):
        """Test reading output with timeout."""
        # Setup mock
        from unittest.mock import MagicMock

        mock_pty = MagicMock()
        mock_pty.is_process_alive = MagicMock(return_value=True)
        session.pty = mock_pty
        session.state = SessionState.ACTIVE

        # Add some test data to buffer
        await session.output_buffer.append(b"test output")

        # Read output
        result = await session.read_output(timeout_ms=100)

        assert result.session_id == "test-session-1"
        assert "test output" in result.output
        assert result.command_count == 0
        assert result.execution_time >= 0

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_read_output_from_dead_session(self, mock_pty_class, session):
        """Test reading from terminated session."""
        session.state = SessionState.TERMINATED

        with pytest.raises(SessionTerminatedError):
            await session.read_output()

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_session_termination(self, mock_pty_class, session):
        """Test session termination."""
        # Setup mock
        from unittest.mock import MagicMock

        mock_pty = MagicMock()
        mock_pty.is_process_alive = MagicMock(return_value=True)
        mock_pty.terminate_process = AsyncMock()
        session.pty = mock_pty
        session.state = SessionState.ACTIVE

        # Create mock tasks - set to None so they're not considered active
        session._reader_task = None
        session._writer_task = None
        session._exit_monitor_task = None

        # Terminate session
        await session.terminate(force=False)

        # Verify termination
        assert session.state == SessionState.TERMINATED
        mock_pty.terminate_process.assert_called_once_with(False)

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_session_cleanup(self, mock_pty_class, session):
        """Test session cleanup."""
        # Setup mock
        from unittest.mock import MagicMock

        mock_pty = MagicMock()
        mock_pty.cleanup = AsyncMock()
        mock_pty.is_process_alive = MagicMock(return_value=False)
        session.pty = mock_pty
        session.state = SessionState.ACTIVE

        # Add some data to buffer
        await session.output_buffer.append(b"test data")
        assert await session.output_buffer.get_size() > 0

        # Cleanup
        await session.cleanup()

        # Verify cleanup
        assert session.state == SessionState.TERMINATED
        mock_pty.cleanup.assert_called_once()
        assert await session.output_buffer.get_size() == 0

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_default_command(self, mock_pty_class, session):
        """Test that default OpenROAD command is used when none specified."""
        mock_pty = AsyncMock()
        mock_pty.is_process_alive = MagicMock(return_value=True)
        session.pty = mock_pty

        await session.start()

        # Verify default command was used
        mock_pty.create_session.assert_called_once_with(["openroad", "-no_init"], None, None)

        # Cleanup
        await session.cleanup()

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_command_with_environment(self, mock_pty_class, session):
        """Test starting session with custom environment and working directory."""
        mock_pty = AsyncMock()
        mock_pty.is_process_alive = MagicMock(return_value=True)
        session.pty = mock_pty

        env = {"TEST_VAR": "value"}
        cwd = "/test/dir"

        await session.start(["custom", "command"], env=env, cwd=cwd)

        # Verify environment and cwd passed through
        mock_pty.create_session.assert_called_once_with(["custom", "command"], env, cwd)

        # Cleanup
        await session.cleanup()

    async def test_is_alive_states(self, session):
        """Test is_alive method in different states."""
        # Creating state
        assert not session.is_alive()

        # Active state with dead process
        session.state = SessionState.ACTIVE
        with patch.object(session.pty, "is_process_alive", return_value=False):
            assert not session.is_alive()
            assert session.state == SessionState.TERMINATED

        # Reset state for next test
        session.state = SessionState.ACTIVE

        # Active state with live process
        with patch.object(session.pty, "is_process_alive", return_value=True):
            assert session.is_alive()
            assert session.state == SessionState.ACTIVE

        # Terminated state
        session.state = SessionState.TERMINATED
        assert not session.is_alive()

    async def test_command_count_increment(self, session):
        """Test that command count increments correctly."""
        session.state = SessionState.ACTIVE
        with patch.object(session.pty, "is_process_alive", return_value=True):
            initial_count = session.command_count

            await session.send_command("cmd1")
            assert session.command_count == initial_count + 1

            await session.send_command("cmd2")
            assert session.command_count == initial_count + 2

    @patch("openroad_mcp.interactive.session.PTYHandler")
    async def test_output_collection_timing(self, mock_pty_class, session):
        """Test output collection with proper timing."""
        mock_pty = AsyncMock()
        mock_pty.is_process_alive = MagicMock(return_value=True)
        session.pty = mock_pty
        session.state = SessionState.ACTIVE

        # Simulate delayed output arrival
        async def delayed_output():
            await asyncio.sleep(0.05)  # 50ms delay
            await session.output_buffer.append(b"delayed output")

        # Start output generation
        asyncio.create_task(delayed_output())

        # Read with sufficient timeout
        result = await session.read_output(timeout_ms=200)

        assert "delayed output" in result.output
        assert 0.04 <= result.execution_time <= 0.20  # Should be around 50ms + some overhead, increased tolerance


@pytest.mark.asyncio
class TestInteractiveSessionAsync:
    """Async test runner for InteractiveSession."""

    async def test_session_lifecycle(self):
        """Test complete session lifecycle."""
        session = InteractiveSession("lifecycle-test")

        try:
            # Mock PTY for testing
            with patch("openroad_mcp.interactive.session.PTYHandler") as mock_pty_class:
                mock_pty = AsyncMock()
                mock_pty.is_process_alive = MagicMock(return_value=True)
                mock_pty_class.return_value = mock_pty
                session.pty = mock_pty

                # Test lifecycle: create -> start -> use -> terminate
                assert session.state == SessionState.CREATING

                await session.start(["echo", "hello"])
                assert session.state == SessionState.ACTIVE

                await session.send_command("test")
                assert session.command_count == 1

                await session.terminate()
                assert session.state == SessionState.TERMINATED

        finally:
            # Ensure cleanup
            await session.cleanup()

    async def test_concurrent_operations(self):
        """Test concurrent session operations."""
        session = InteractiveSession("concurrent-test")

        try:
            with patch("openroad_mcp.interactive.session.PTYHandler") as mock_pty_class:
                mock_pty = AsyncMock()
                mock_pty.is_process_alive = MagicMock(return_value=True)
                # Mock the methods that background tasks will call
                mock_pty.read_output.return_value = b""  # Return empty data
                mock_pty.write_input.return_value = None

                # Make wait_for_exit wait indefinitely (until cancelled)
                async def wait_forever():
                    await asyncio.Event().wait()  # Wait forever until cancelled

                mock_pty.wait_for_exit = wait_forever

                mock_pty_class.return_value = mock_pty
                session.pty = mock_pty

                await session.start()

                # Run concurrent operations
                tasks = [session.send_command(f"command_{i}") for i in range(5)]

                await asyncio.gather(*tasks)
                assert session.command_count == 5

        finally:
            await session.cleanup()
