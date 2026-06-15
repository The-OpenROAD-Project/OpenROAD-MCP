"""Integration tests for PTY functionality using real processes."""

import asyncio
import os
from unittest.mock import patch

import pytest

from openroad_mcp.config.settings import settings
from openroad_mcp.interactive.models import PTYError
from openroad_mcp.interactive.pty_handler import PTYHandler


def can_create_pty() -> bool:
    """Check if PTY creation is supported in current environment."""
    try:
        import pty

        master_fd, slave_fd = pty.openpty()
        os.close(master_fd)
        os.close(slave_fd)
        return True
    except (OSError, ImportError):
        return False


skip_if_no_pty = pytest.mark.skipif(not can_create_pty(), reason="PTY not supported in current environment")


@pytest.mark.asyncio
class TestPTYIntegration:
    """Integration tests for PTY functionality with real processes."""

    @pytest.fixture(autouse=True)
    def disable_command_validation(self):
        """Disable command validation for integration tests."""
        with patch.object(settings, "ENABLE_COMMAND_VALIDATION", False):
            yield

    @pytest.fixture
    async def pty_handler(self):
        """Create and cleanup PTY handler."""
        handler = PTYHandler()
        try:
            yield handler
        finally:
            await handler.cleanup()

    @skip_if_no_pty
    async def test_basic_echo_command(self, pty_handler):
        """Test basic command execution with output capture."""
        await pty_handler.create_session(["echo", "hello world"])

        assert pty_handler.is_process_alive()

        # Wait for process to complete
        exit_code = await pty_handler.wait_for_exit(timeout=2.0)
        assert exit_code == 0

        # Read output
        output = await pty_handler.read_output()
        assert output is not None
        assert b"hello world" in output

    @skip_if_no_pty
    async def test_interactive_input_output(self, pty_handler):
        """Test interactive input/output with cat command."""
        await pty_handler.create_session(["cat"])

        assert pty_handler.is_process_alive()

        # Send input
        test_input = b"test line\n"
        await pty_handler.write_input(test_input)

        # Read echoed output
        output = None
        for _ in range(10):
            output = await pty_handler.read_output()
            if output:
                break
            await asyncio.sleep(0.1)

        assert output is not None
        assert b"test line" in output

        # Terminate cat process
        await pty_handler.terminate_process()
        assert not pty_handler.is_process_alive()

    @skip_if_no_pty
    async def test_multi_line_output(self, pty_handler):
        """Test handling of multi-line command output."""
        cmd = ["bash", "-c", "echo line1; echo line2; echo line3"]
        await pty_handler.create_session(cmd)

        assert pty_handler.is_process_alive()

        # Wait for completion
        exit_code = await pty_handler.wait_for_exit(timeout=2.0)
        assert exit_code == 0

        # Read all output
        output = await pty_handler.read_output()
        assert output is not None

        output_str = output.decode("utf-8", errors="ignore")
        assert "line1" in output_str
        assert "line2" in output_str
        assert "line3" in output_str

    @skip_if_no_pty
    async def test_process_lifecycle(self, pty_handler):
        """Test complete process lifecycle management."""
        # Start long-running process
        await pty_handler.create_session(["sleep", "10"])

        # Verify it's alive
        assert pty_handler.is_process_alive()

        # Terminate gracefully
        await pty_handler.terminate_process(force=False)

        # Verify termination
        assert not pty_handler.is_process_alive()

        # Cleanup should be safe to call multiple times
        await pty_handler.cleanup()
        await pty_handler.cleanup()

    @skip_if_no_pty
    async def test_error_handling_invalid_command(self, pty_handler):
        """Test error handling for invalid commands."""
        with pytest.raises(PTYError):
            await pty_handler.create_session(["/nonexistent/command"])

    @skip_if_no_pty
    async def test_concurrent_read_write(self, pty_handler):
        """Test concurrent read/write operations."""
        await pty_handler.create_session(["cat"])

        assert pty_handler.is_process_alive()

        # Define concurrent operations
        async def write_data():
            for i in range(3):
                await pty_handler.write_input(f"line {i}\n".encode())
                await asyncio.sleep(0.1)
            await pty_handler.terminate_process()

        async def read_data():
            collected_output = b""
            for _ in range(10):  # Try reading multiple times
                output = await pty_handler.read_output()
                if output:
                    collected_output += output
                await asyncio.sleep(0.1)
                if not pty_handler.is_process_alive():
                    break
            return collected_output

        # Run operations concurrently
        write_task = asyncio.create_task(write_data())
        read_task = asyncio.create_task(read_data())

        await write_task
        output = await read_task

        # Verify we got expected output
        output_str = output.decode("utf-8", errors="ignore")
        assert "line 0" in output_str
        assert "line 1" in output_str
        assert "line 2" in output_str

    @skip_if_no_pty
    async def test_environment_and_working_directory(self, pty_handler, tmp_path):
        """Test PTY session with custom environment and working directory."""
        # Create test file in temp directory
        test_file = tmp_path / "test.txt"
        test_file.write_text("test content")

        # Set custom environment
        env = {"TEST_VAR": "test_value"}

        # Run command that uses environment and working directory
        cmd = ["bash", "-c", "echo $TEST_VAR; ls test.txt"]
        await pty_handler.create_session(cmd, env=env, cwd=str(tmp_path))

        assert pty_handler.is_process_alive()

        # Wait for completion
        exit_code = await pty_handler.wait_for_exit(timeout=2.0)
        assert exit_code == 0

        # Read output
        output = await pty_handler.read_output()
        assert output is not None

        output_str = output.decode("utf-8", errors="ignore")
        assert "test_value" in output_str  # Environment variable
        assert "test.txt" in output_str  # File from working directory

    @skip_if_no_pty
    async def test_large_output_handling(self, pty_handler):
        """Test handling of large output."""
        # Generate large output with proper variable expansion
        cmd = [
            "bash",
            "-c",
            'for i in {1..100}; do echo "This is line $i with some extra text to make it longer"; done',
        ]
        await pty_handler.create_session(cmd)

        assert pty_handler.is_process_alive()

        # Wait for completion
        exit_code = await pty_handler.wait_for_exit(timeout=5.0)
        assert exit_code == 0

        # Read output in chunks
        collected_output = b""
        while True:
            output = await pty_handler.read_output()
            if output:
                collected_output += output
            else:
                break

        # Verify we got substantial output
        assert len(collected_output) > 1000
        output_str = collected_output.decode("utf-8", errors="ignore")
        assert "line 1" in output_str
        assert "line 100" in output_str

    @skip_if_no_pty
    async def test_timeout_behavior(self, pty_handler):
        """Test timeout behavior for long-running processes."""
        await pty_handler.create_session(["sleep", "5"])

        assert pty_handler.is_process_alive()

        # Wait with short timeout - should timeout
        exit_code = await pty_handler.wait_for_exit(timeout=0.1)
        assert exit_code is None  # Timeout occurred
        assert pty_handler.is_process_alive()  # Still running

        # Force termination
        await pty_handler.terminate_process(force=True)

        # Give a moment for the process to actually die
        await asyncio.sleep(0.1)
        assert not pty_handler.is_process_alive()

    @skip_if_no_pty
    async def test_sequential_commands(self, pty_handler):
        """Test running multiple commands sequentially in same PTY."""
        # Run first command
        await pty_handler.create_session(["echo", "first"])
        exit_code = await pty_handler.wait_for_exit(timeout=2.0)
        assert exit_code == 0

        # Clean up first session
        await pty_handler.cleanup()

        # Run second command
        await pty_handler.create_session(["echo", "second"])
        exit_code = await pty_handler.wait_for_exit(timeout=2.0)
        assert exit_code == 0

        output = await pty_handler.read_output()
        assert output is not None
        assert b"second" in output
