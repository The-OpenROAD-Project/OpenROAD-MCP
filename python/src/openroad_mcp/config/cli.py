"""Command line interface configuration for OpenROAD MCP server."""

import argparse

from pydantic import BaseModel, Field, ValidationError


class TransportConfig(BaseModel):
    """Configuration for different transport modes."""

    mode: str = Field(description="Transport mode: 'stdio' or 'http'")
    host: str = Field(default="localhost", description="HTTP server host (http mode only)")
    port: int = Field(default=8000, description="HTTP server port (http mode only)")


class CLIConfig(BaseModel):
    """Complete CLI configuration."""

    transport: TransportConfig = Field(description="Transport configuration")
    verbose: bool = Field(default=False, description="Enable verbose logging")
    log_level: str = Field(default="INFO", description="Logging level")

    @classmethod
    def from_args(cls, args: argparse.Namespace) -> "CLIConfig":
        """Create configuration from parsed command line arguments."""
        try:
            transport_config = TransportConfig(
                mode=args.transport,
                host=args.host,
                port=args.port,
            )

            return cls(
                transport=transport_config,
                verbose=args.verbose,
                log_level=args.log_level,
            )
        except ValidationError as e:
            raise ValueError(f"Invalid CLI configuration: {e}") from e


def create_argument_parser() -> argparse.ArgumentParser:
    """Create and configure the command line argument parser."""
    parser = argparse.ArgumentParser(
        prog="openroad-mcp",
        description="OpenROAD Model Context Protocol (MCP) Server",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Run with default stdio transport (most common)
  %(prog)s

  # Run with stdio transport explicitly
  %(prog)s --transport stdio

  # Run with HTTP transport on custom host/port
  %(prog)s --transport http --host 0.0.0.0 --port 8080

  # Enable verbose logging
  %(prog)s --verbose --log-level DEBUG
        """,
    )

    # Transport mode configuration
    transport_group = parser.add_argument_group("transport", "Transport mode configuration")
    transport_group.add_argument(
        "--transport",
        "-t",
        choices=["stdio", "http"],
        default="stdio",
        help="Transport mode for the MCP server (default: %(default)s)",
    )

    # HTTP-specific options (only used when transport is http)
    http_group = parser.add_argument_group("http", "HTTP transport options (http mode only)")
    http_group.add_argument(
        "--host",
        default="localhost",
        help="HTTP server host address (default: %(default)s)",
    )
    http_group.add_argument(
        "--port",
        type=int,
        default=8000,
        help="HTTP server port (default: %(default)s)",
    )

    # Logging configuration
    logging_group = parser.add_argument_group("logging", "Logging configuration")
    logging_group.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Enable verbose logging",
    )
    logging_group.add_argument(
        "--log-level",
        choices=["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
        default="INFO",
        help="Set logging level (default: %(default)s)",
    )

    return parser


def parse_cli_args(args: list[str] | None = None) -> CLIConfig:
    """Parse command line arguments and return configuration."""
    parser = create_argument_parser()
    parsed_args = parser.parse_args(args)

    # Validate that HTTP options are only used with http transport
    if parsed_args.transport != "http":
        # Check if HTTP-specific options were explicitly set
        if parsed_args.host != "localhost" or parsed_args.port != 8000:
            parser.error("--host and --port options are only valid with --transport http")

    return CLIConfig.from_args(parsed_args)


def get_cli_help() -> str:
    """Get formatted help text for the CLI."""
    parser = create_argument_parser()
    return parser.format_help()
