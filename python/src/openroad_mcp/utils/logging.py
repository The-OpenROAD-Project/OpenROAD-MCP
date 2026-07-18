"""Logging configuration utilities."""

import logging
import sys

from ..config.settings import settings


def setup_logging(level: str | None = None, format_string: str | None = None) -> None:
    """Configure logging for the application."""
    log_level = level or settings.LOG_LEVEL
    log_format = format_string or settings.LOG_FORMAT

    # Convert string level to logging constant
    numeric_level = getattr(logging, log_level.upper(), logging.INFO)

    # Configure root logger
    logging.basicConfig(
        level=numeric_level, format=log_format, handlers=[logging.StreamHandler(sys.stderr)], force=True
    )

    # Set specific logger levels
    logging.getLogger("openroad_mcp").setLevel(numeric_level)


def get_logger(name: str) -> logging.Logger:
    """Get a logger instance with the given name."""
    return logging.getLogger(f"openroad_mcp.{name}")
