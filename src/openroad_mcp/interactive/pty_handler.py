"""PTY (pseudo-terminal) handler for true terminal emulation."""

import asyncio
import errno
import fcntl
import os
import pty
import termios

from ..config.constants import LARGE_IO_THRESHOLD
from ..config.settings import settings
from ..utils.logging import get_logger
from .models import PTYError

logger = get_logger("pty_handler")


class PTYHandler:
    """Handles PTY creation and I/O operations for terminal emulation."""

    def __init__(self) -> None:
        self.master_fd: int | None = None
        self.slave_fd: int | None = None
        self.process: asyncio.subprocess.Process | None = None
        self._original_attrs: list | None = None

    def _validate_command(self, command: list[str]) -> None:
        """Validate command against allowlist to prevent command injection."""
        if not settings.ENABLE_COMMAND_VALIDATION:
            logger.warning("Command validation is disabled - this is a security risk")
            return

        if not command:
            raise PTYError("Command list cannot be empty")

        executable = command[0]

        if os.path.isabs(executable):
            raise PTYError(
                f"Command '{executable}' must not be an absolute path. "
                f"Use the binary name only (e.g. 'openroad'). "
                f"To add this command, set OPENROAD_ALLOWED_COMMANDS environment variable."
            )

        if executable not in settings.ALLOWED_COMMANDS:
            allowed_list = ", ".join(settings.ALLOWED_COMMANDS)
            raise PTYError(
                f"Command '{executable}' is not in the allowed commands list. "
                f"Allowed commands: {allowed_list}. "
                f"To add this command, set OPENROAD_ALLOWED_COMMANDS environment variable."
            )

        for i, arg in enumerate(command):
            if any(char in arg for char in [";", "&", "|", "$", "`", "\n", "\r"]):
                raise PTYError(f"Command argument {i} contains shell metacharacters which are not allowed: {arg!r}")

            if arg.startswith(">") or arg.startswith("<"):
                raise PTYError(f"Command argument {i} contains redirection operators which are not allowed: {arg!r}")

        logger.debug(f"Command validation passed for: {' '.join(command)}")

    async def __aenter__(self) -> "PTYHandler":
        """Async context manager entry."""
        return self

    async def __aexit__(
        self, exc_type: type[BaseException] | None, exc_val: BaseException | None, exc_tb: object
    ) -> None:
        """Async context manager exit with guaranteed cleanup."""
        await self.cleanup()

    async def create_session(
        self,
        command: list[str],
        env: dict[str, str] | None = None,
        cwd: str | None = None,
    ) -> None:
        """Create PTY pair and spawn process with terminal emulation."""
        try:
            self._validate_command(command)

            self.master_fd, self.slave_fd = pty.openpty()
            logger.debug(f"Created PTY pair: master={self.master_fd}, slave={self.slave_fd}")

            # Configure terminal settings
            self._configure_terminal()

            # Prepare environment
            process_env = os.environ.copy()
            if env:
                process_env.update(env)

            # Set terminal environment variables
            process_env.update(
                {
                    "TERM": "xterm-256color",
                    "COLUMNS": "80",
                    "LINES": "24",
                }
            )

            # Create subprocess with slave as stdin/stdout/stderr
            self.process = await asyncio.create_subprocess_exec(
                *command,
                stdin=self.slave_fd,
                stdout=self.slave_fd,
                stderr=self.slave_fd,
                env=process_env,
                cwd=cwd,
                preexec_fn=os.setsid,  # Create new session
            )

            logger.info(f"Created PTY session with PID {self.process.pid} for command: {' '.join(command)}")

            # Close slave FD in parent - child has its own copy
            if self.slave_fd is not None:
                self._before_slave_close(self.slave_fd)
                os.close(self.slave_fd)
                logger.debug(f"Closed slave FD {self.slave_fd} in parent process")
                self.slave_fd = None

        except OSError as e:
            raise PTYError(f"Failed to create PTY session: {e}") from e
        except Exception as e:
            await self.cleanup()
            raise PTYError(f"Unexpected error creating PTY session: {e}") from e

    def _before_slave_close(self, slave_fd: int) -> None:
        """Called just before the parent closes the slave fd. Override to dup if needed."""
        pass

    def _configure_terminal(self) -> None:
        """Configure terminal attributes for optimal OpenROAD interaction."""
        if self.slave_fd is None:
            raise PTYError("Cannot configure terminal: slave_fd is None")

        try:
            # Get current terminal attributes
            self._original_attrs = termios.tcgetattr(self.slave_fd)
            attrs = termios.tcgetattr(self.slave_fd)

            # Configure for raw mode with some cooked features
            # Enable canonical mode for line editing but disable echo
            attrs[3] &= ~termios.ECHO  # Disable echo (we'll handle output)
            attrs[3] |= termios.ICANON  # Enable canonical mode for line editing

            # Set input/output processing
            attrs[0] |= termios.ICRNL  # Map CR to NL on input
            attrs[1] |= termios.OPOST | termios.ONLCR  # Enable output processing

            # Apply changes
            termios.tcsetattr(self.slave_fd, termios.TCSANOW, attrs)

            # Configure master for non-blocking reads
            if self.master_fd is not None:
                flags = fcntl.fcntl(self.master_fd, fcntl.F_GETFL)
                fcntl.fcntl(self.master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

            logger.debug("Configured terminal attributes for PTY")

        except (OSError, termios.error) as e:
            raise PTYError(f"Failed to configure terminal: {e}") from e

    async def write_input(self, data: bytes) -> None:
        """Write data to PTY master (goes to process stdin).

        Uses direct write to non-blocking file descriptor for optimal performance.
        """
        if self.master_fd is None:
            raise PTYError("Cannot write: master_fd is None")

        try:
            # Direct write to non-blocking FD
            bytes_written = os.write(self.master_fd, data)
            if bytes_written != len(data):
                logger.warning(f"Partial write: {bytes_written}/{len(data)} bytes")
            elif bytes_written > LARGE_IO_THRESHOLD:
                logger.debug(f"Large write: {bytes_written} bytes to PTY")

        except (OSError, BrokenPipeError) as e:
            raise PTYError(f"Failed to write to PTY: {e}") from e

    async def read_output(self, size: int | None = None) -> bytes | None:
        """Read data from PTY master (process output).

        Uses direct read from non-blocking file descriptor instead of thread pools
        for better performance and proper async I/O patterns.
        """
        if size is None:
            size = settings.READ_CHUNK_SIZE
        if self.master_fd is None:
            raise PTYError("Cannot read: master_fd is None")

        try:
            # Direct read from non-blocking FD - no threading needed
            data = os.read(self.master_fd, size)
            if data and len(data) > LARGE_IO_THRESHOLD:
                logger.debug(f"Large read: {len(data)} bytes from PTY")
            return data

        except BlockingIOError:
            # No data available right now (expected with non-blocking I/O)
            return None
        except OSError as e:
            if e.errno == errno.EIO:  # EIO - process terminated
                logger.debug("PTY read failed: process terminated")
                return None
            raise PTYError(f"Failed to read from PTY: {e}") from e

    def is_process_alive(self) -> bool:
        """Check if the spawned process is still alive."""
        if self.process is None:
            return False

        return self.process.returncode is None

    async def wait_for_exit(self, timeout: float | None = None) -> int | None:
        """Wait for process to exit and return exit code."""
        if self.process is None:
            return None

        try:
            if timeout:
                await asyncio.wait_for(self.process.wait(), timeout=timeout)
            else:
                await self.process.wait()
            return self.process.returncode
        except TimeoutError:
            return None

    async def terminate_process(self, force: bool = False) -> None:
        """Terminate the spawned process."""
        if self.process is None:
            return

        if not self.is_process_alive():
            logger.debug("Process already terminated")
            return

        try:
            if force:
                # Send SIGKILL for immediate termination
                self.process.kill()
                logger.info(f"Sent SIGKILL to process {self.process.pid}")
            else:
                # Send SIGTERM for graceful termination
                self.process.terminate()
                logger.info(f"Sent SIGTERM to process {self.process.pid}")

                # Wait for graceful shutdown
                try:
                    await asyncio.wait_for(self.process.wait(), timeout=5.0)
                except TimeoutError:
                    # Force kill if graceful shutdown fails
                    logger.warning("Graceful shutdown timeout, forcing termination")
                    self.process.kill()
                    await self.process.wait()

        except ProcessLookupError:
            # Process already dead
            logger.debug("Process already terminated during termination attempt")

    async def cleanup(self) -> None:
        """Clean up PTY resources and terminate process."""
        logger.debug("Cleaning up PTY handler")

        # Terminate process if running
        if self.process and self.is_process_alive():
            await self.terminate_process()

        # Restore original terminal attributes
        if self.slave_fd is not None and self._original_attrs is not None:
            try:
                termios.tcsetattr(self.slave_fd, termios.TCSANOW, self._original_attrs)
            except (OSError, termios.error):
                pass  # Best effort cleanup

        # Close file descriptors
        for fd in [self.master_fd, self.slave_fd]:
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass  # Best effort cleanup

        # Reset state
        self.master_fd = None
        self.slave_fd = None
        self.process = None
        self._original_attrs = None

        logger.debug("PTY handler cleanup completed")


