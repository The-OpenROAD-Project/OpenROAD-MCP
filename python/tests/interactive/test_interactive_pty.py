"""Tests for PTYHandler implementation."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from openroad_mcp.interactive.models import PTYError
from openroad_mcp.interactive.pty_handler import PTYHandler


@pytest.mark.asyncio
class TestPTYHandler:
    """Test suite for PTYHandler."""

    @pytest.fixture(autouse=True)
    def disable_command_validation(self):
        """Disable command validation for unit tests."""
        from openroad_mcp.config.settings import settings

        with patch.object(settings, "ENABLE_COMMAND_VALIDATION", False):
            yield

    @pytest.fixture
    def pty_handler(self):
        """Create a test PTY handler."""
        handler = PTYHandler()
        yield handler
        handler.master_fd = None
        handler.slave_fd = None
        handler.process = None

    async def test_pty_handler_initialization(self, pty_handler):
        """Test PTY handler initialization."""
        assert pty_handler.master_fd is None
        assert pty_handler.slave_fd is None
        assert pty_handler.process is None
        assert pty_handler._original_attrs is None

    @patch("openroad_mcp.interactive.pty_handler.pty.openpty")
    @patch("openroad_mcp.interactive.pty_handler.termios.tcgetattr")
    @patch("openroad_mcp.interactive.pty_handler.termios.tcsetattr")
    @patch("openroad_mcp.interactive.pty_handler.fcntl.fcntl")
    @patch("openroad_mcp.interactive.pty_handler.asyncio.create_subprocess_exec", new_callable=AsyncMock)
    @patch("openroad_mcp.interactive.pty_handler.os.close")
    async def test_create_session_success(
        self,
        mock_os_close,
        mock_subprocess,
        mock_fcntl,
        mock_tcsetattr,
        mock_tcgetattr,
        mock_openpty,
        pty_handler,
        tmp_path,
    ):
        """Test successful PTY session creation."""
        # Setup mocks
        mock_openpty.return_value = (10, 11)  # master_fd, slave_fd
        mock_tcgetattr.return_value = [0, 0, 0, 0, 0, 0]  # Mock termios attrs
        mock_fcntl.return_value = 0

        mock_process = MagicMock()
        mock_process.pid = 12345
        mock_subprocess.return_value = mock_process

        # Create session
        await pty_handler.create_session(["echo", "hello"], env={"TEST": "value"}, cwd=str(tmp_path))

        # Verify PTY creation
        mock_openpty.assert_called_once()
        assert pty_handler.master_fd == 10
        assert pty_handler.slave_fd is None  # Should be closed in parent

        # Verify slave FD was closed
        mock_os_close.assert_called_once_with(11)

        # Verify terminal configuration
        mock_tcgetattr.assert_called_with(11)
        mock_tcsetattr.assert_called()
        mock_fcntl.assert_called()

        # Verify process creation
        mock_subprocess.assert_called_once()
        call_args = mock_subprocess.call_args
        assert call_args[0] == ("echo", "hello")  # Command args
        assert call_args[1]["stdin"] == 11
        assert call_args[1]["stdout"] == 11
        assert call_args[1]["stderr"] == 11
        assert call_args[1]["cwd"] == str(tmp_path)
        assert "TEST" in call_args[1]["env"]
        assert "TERM" in call_args[1]["env"]

        assert pty_handler.process == mock_process

    @patch("openroad_mcp.interactive.pty_handler.pty.openpty")
    async def test_create_session_pty_failure(self, mock_openpty, pty_handler):
        """Test PTY creation failure handling."""
        mock_openpty.side_effect = OSError("PTY creation failed")

        with pytest.raises(PTYError, match="Failed to create PTY session"):
            await pty_handler.create_session(["echo", "test"])

    @patch("openroad_mcp.interactive.pty_handler.pty.openpty")
    @patch("openroad_mcp.interactive.pty_handler.termios.tcgetattr")
    @patch("openroad_mcp.interactive.pty_handler.os.close")
    async def test_create_session_terminal_config_failure(
        self, mock_os_close, mock_tcgetattr, mock_openpty, pty_handler
    ):
        """Test terminal configuration failure handling."""
        mock_openpty.return_value = (10, 11)
        mock_tcgetattr.side_effect = OSError("Terminal config failed")

        with pytest.raises(PTYError, match="Failed to configure terminal"):
            await pty_handler.create_session(["echo", "test"])

    @patch("openroad_mcp.interactive.pty_handler.os.write")
    async def test_write_input_success(self, mock_write, pty_handler):
        """Test successful input writing."""
        pty_handler.master_fd = 10
        mock_write.return_value = 5

        await pty_handler.write_input(b"hello")

        mock_write.assert_called_once_with(10, b"hello")

    async def test_write_input_no_fd(self, pty_handler):
        """Test writing input when no master_fd."""
        with pytest.raises(PTYError, match="Cannot write: master_fd is None"):
            await pty_handler.write_input(b"test")

    @patch("openroad_mcp.interactive.pty_handler.os.write")
    async def test_write_input_failure(self, mock_write, pty_handler):
        """Test input writing failure."""
        pty_handler.master_fd = 10
        mock_write.side_effect = BrokenPipeError("Pipe broken")

        with pytest.raises(PTYError, match="Failed to write to PTY"):
            await pty_handler.write_input(b"test")

    @patch("openroad_mcp.interactive.pty_handler.os.read")
    async def test_read_output_success(self, mock_read, pty_handler):
        """Test successful output reading."""
        pty_handler.master_fd = 10
        mock_read.return_value = b"output data"

        result = await pty_handler.read_output(1024)

        assert result == b"output data"
        mock_read.assert_called_once_with(10, 1024)

    @patch("openroad_mcp.interactive.pty_handler.os.read")
    async def test_read_output_blocking(self, mock_read, pty_handler):
        """Test reading when no data available (BlockingIOError)."""
        pty_handler.master_fd = 10
        mock_read.side_effect = BlockingIOError()

        result = await pty_handler.read_output(1024)

        assert result is None

    @patch("openroad_mcp.interactive.pty_handler.os.read")
    async def test_read_output_process_terminated(self, mock_read, pty_handler):
        """Test reading when process terminated (EIO)."""
        pty_handler.master_fd = 10
        mock_read.side_effect = OSError(5, "Input/output error")  # EIO

        result = await pty_handler.read_output(1024)

        assert result is None

    async def test_read_output_no_fd(self, pty_handler):
        """Test reading output when no master_fd."""
        with pytest.raises(PTYError, match="Cannot read: master_fd is None"):
            await pty_handler.read_output()

    async def test_is_process_alive_no_process(self, pty_handler):
        """Test is_process_alive when no process."""
        assert not pty_handler.is_process_alive()

    async def test_is_process_alive_with_process(self, pty_handler):
        """Test is_process_alive with mock process."""
        mock_process = MagicMock()
        mock_process.returncode = None  # Still running
        pty_handler.process = mock_process

        assert pty_handler.is_process_alive()

        mock_process.returncode = 0  # Exited
        assert not pty_handler.is_process_alive()

    async def test_wait_for_exit_no_process(self, pty_handler):
        """Test waiting for exit when no process."""
        result = await pty_handler.wait_for_exit()
        assert result is None

    async def test_wait_for_exit_with_timeout(self, pty_handler):
        """Test waiting for exit with timeout."""

        mock_process = MagicMock()
        mock_process.wait = AsyncMock()
        pty_handler.process = mock_process

        with patch("asyncio.wait_for", new_callable=AsyncMock, side_effect=TimeoutError()):
            result = await pty_handler.wait_for_exit(timeout=0.01)
            assert result is None

    async def test_wait_for_exit_success(self, pty_handler):
        """Test successful wait for exit."""
        mock_process = MagicMock()
        mock_process.wait = AsyncMock(return_value=None)
        mock_process.returncode = 0
        pty_handler.process = mock_process

        result = await pty_handler.wait_for_exit()
        assert result == 0

    async def test_terminate_process_no_process(self, pty_handler):
        """Test terminating when no process."""
        # Should not raise exception
        await pty_handler.terminate_process()

    async def test_terminate_process_already_dead(self, pty_handler):
        """Test terminating already dead process."""
        mock_process = MagicMock()
        mock_process.returncode = 0  # Already exited
        pty_handler.process = mock_process

        await pty_handler.terminate_process()
        # Should not call terminate on dead process

    @patch("openroad_mcp.interactive.pty_handler.os.close")
    async def test_terminate_process_graceful(self, _mock_close, pty_handler):
        """Test graceful process termination."""
        mock_process = MagicMock()
        mock_process.returncode = None  # Still running
        mock_process.wait = AsyncMock(return_value=None)
        pty_handler.process = mock_process

        await pty_handler.terminate_process(force=False)

        mock_process.terminate.assert_called_once()
        mock_process.wait.assert_called()

    @patch("openroad_mcp.interactive.pty_handler.asyncio.wait_for", new_callable=AsyncMock)
    @patch("openroad_mcp.interactive.pty_handler.os.close")
    async def test_terminate_process_force_after_timeout(self, _mock_close, mock_wait_for, pty_handler):
        """Test forced termination after graceful timeout."""
        mock_process = MagicMock()
        mock_process.returncode = None
        mock_process.wait = AsyncMock(return_value=None)
        # First call to wait_for times out, second call succeeds
        mock_wait_for.side_effect = [TimeoutError(), None]
        pty_handler.process = mock_process

        await pty_handler.terminate_process(force=False)

        mock_process.terminate.assert_called_once()
        mock_process.kill.assert_called_once()

    @patch("openroad_mcp.interactive.pty_handler.os.close")
    async def test_terminate_process_force_immediate(self, _mock_close, pty_handler):
        """Test immediate forced termination."""
        mock_process = MagicMock()
        mock_process.returncode = None
        pty_handler.process = mock_process

        await pty_handler.terminate_process(force=True)

        mock_process.kill.assert_called_once()
        mock_process.terminate.assert_not_called()

    @patch("openroad_mcp.interactive.pty_handler.termios.tcsetattr")
    @patch("openroad_mcp.interactive.pty_handler.os.close")
    async def test_cleanup_success(self, mock_close, mock_tcsetattr, pty_handler):
        """Test successful cleanup."""
        # Setup handler state
        mock_process = MagicMock()
        mock_process.returncode = None
        mock_process.terminate = MagicMock()
        mock_process.wait = AsyncMock(return_value=None)
        pty_handler.process = mock_process
        pty_handler.master_fd = 10
        pty_handler.slave_fd = 11
        pty_handler._original_attrs = [0, 0, 0, 0, 0, 0]

        await pty_handler.cleanup()

        # Verify process termination
        mock_process.terminate.assert_called_once()

        # Verify terminal restoration
        mock_tcsetattr.assert_called_once()

        # Verify file descriptor closure
        assert mock_close.call_count == 2
        mock_close.assert_any_call(10)
        mock_close.assert_any_call(11)

        # Verify state reset
        assert pty_handler.master_fd is None
        assert pty_handler.slave_fd is None
        assert pty_handler.process is None
        assert pty_handler._original_attrs is None

    @patch("openroad_mcp.interactive.pty_handler.os.close")
    async def test_cleanup_with_errors(self, mock_close, pty_handler):
        """Test cleanup with errors (should not raise)."""
        pty_handler.master_fd = 10
        pty_handler.slave_fd = 11
        mock_close.side_effect = OSError("Close failed")

        # Should not raise exception
        await pty_handler.cleanup()

        # State should still be reset
        assert pty_handler.master_fd is None
        assert pty_handler.slave_fd is None

    @patch("openroad_mcp.interactive.pty_handler.os.close")
    async def test_explicit_cleanup(self, mock_close):
        """Test explicit cleanup of file descriptors."""
        handler = PTYHandler()
        handler.master_fd = 10
        handler.slave_fd = 11

        # Explicitly call cleanup
        await handler.cleanup()

        # Should attempt to close file descriptors
        assert mock_close.call_count == 2
        assert handler.master_fd is None
        assert handler.slave_fd is None


@pytest.mark.asyncio
class TestPTYHandlerAsync:
    """Async test runner for PTYHandler."""

    async def test_pty_handler_lifecycle(self):
        """Test complete PTY handler lifecycle."""
        from openroad_mcp.config.settings import settings

        with (
            patch.object(settings, "ENABLE_COMMAND_VALIDATION", False),
            patch("openroad_mcp.interactive.pty_handler.pty.openpty") as mock_openpty,
            patch("openroad_mcp.interactive.pty_handler.termios.tcgetattr") as mock_tcgetattr,
            patch("openroad_mcp.interactive.pty_handler.termios.tcsetattr"),
            patch("openroad_mcp.interactive.pty_handler.fcntl.fcntl"),
            patch(
                "openroad_mcp.interactive.pty_handler.asyncio.create_subprocess_exec", new_callable=AsyncMock
            ) as mock_subprocess,
            patch("openroad_mcp.interactive.pty_handler.os.close"),
            patch("openroad_mcp.interactive.pty_handler.os.write") as mock_write,
        ):
            # Setup mocks
            mock_openpty.return_value = (10, 11)
            mock_tcgetattr.return_value = [0, 0, 0, 0, 0, 0]
            mock_process = MagicMock()
            mock_process.pid = 12345
            mock_process.returncode = None
            mock_subprocess.return_value = mock_process
            mock_write.return_value = 6  # Return length of "hello\n"

            # Create handler inside mocked context
            handler = PTYHandler()

            try:
                # Test lifecycle
                await handler.create_session(["echo", "test"])
                assert handler.is_process_alive()

                await handler.write_input(b"hello\n")

                # Simulate process exit
                mock_process.returncode = 0
                assert not handler.is_process_alive()

                await handler.terminate_process()

            finally:
                await handler.cleanup()
