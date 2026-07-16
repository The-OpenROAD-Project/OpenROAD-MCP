"""Interactive shell infrastructure for OpenROAD MCP.

This package provides PTY-based interactive shell sessions with true terminal
emulation, circular output buffering, and session management capabilities.
"""

from ..core.models import InteractiveExecResult, InteractiveSessionInfo, SessionState
from .buffer import CircularBuffer
from .pty_handler import PTYHandler
from .session import InteractiveSession

__all__ = [
    "CircularBuffer",
    "InteractiveExecResult",
    "InteractiveSession",
    "InteractiveSessionInfo",
    "PTYHandler",
    "SessionState",
]
