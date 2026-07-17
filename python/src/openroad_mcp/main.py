"""Main entry point for OpenROAD MCP server."""

import asyncio
import sys

from openroad_mcp.config.cli import parse_cli_args
from openroad_mcp.config.constants import EXIT_CODE_ERROR, EXIT_CODE_KEYBOARD_INTERRUPT
from openroad_mcp.server import run_server
from openroad_mcp.utils.logging import setup_logging


def main() -> None:
    """Main application entry point."""
    try:
        # Parse command line arguments
        config = parse_cli_args()

        # Setup logging with CLI configuration
        log_level = config.log_level
        if config.verbose:
            log_level = "DEBUG"
        setup_logging(level=log_level)

        # Run the server with the parsed configuration
        asyncio.run(run_server(config))

    except ValueError as e:
        print(f"Configuration error: {e}", file=sys.stderr)
        sys.exit(EXIT_CODE_ERROR)
    except KeyboardInterrupt:
        print("\nInterrupted by user", file=sys.stderr)
        sys.exit(EXIT_CODE_KEYBOARD_INTERRUPT)
    except Exception as e:
        print(f"Unexpected error: {e}", file=sys.stderr)
        sys.exit(EXIT_CODE_ERROR)


if __name__ == "__main__":
    main()
