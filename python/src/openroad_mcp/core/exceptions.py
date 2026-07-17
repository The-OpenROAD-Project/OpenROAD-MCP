"""Custom exceptions for OpenROAD MCP server."""


class OpenROADError(Exception):
    """Base exception for OpenROAD-related errors."""

    pass


class ValidationError(OpenROADError):
    """Raised when validation fails."""

    pass
