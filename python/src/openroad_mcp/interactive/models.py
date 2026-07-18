"""Data models for interactive shell functionality."""


class SessionError(Exception):
    """Base exception for session-related errors."""

    def __init__(self, message: str, session_id: str | None = None):
        super().__init__(message)
        self.session_id = session_id


class SessionNotFoundError(SessionError):
    """Raised when a session ID is not found."""


class SessionTerminatedError(SessionError):
    """Raised when attempting to use a terminated session."""


class CommandBlockedError(SessionError):
    """Raised when a command is blocked by the whitelist."""

    def __init__(self, command_verb: str, session_id: str | None = None):
        super().__init__(
            f"Command '{command_verb}' is not allowed. Only OpenROAD and safe Tcl commands are permitted.",
            session_id,
        )
        self.command_verb = command_verb


class PTYError(Exception):
    """Raised when PTY operations fail."""
