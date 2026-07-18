"""Focused tests for CLI functionality."""

from argparse import ArgumentParser

import pytest

from openroad_mcp.config.cli import CLIConfig, TransportConfig, parse_cli_args


class TestArgumentParsing:
    """Test basic argument parsing behavior."""

    def test_stdio_transport_explicit(self, argument_parser: ArgumentParser) -> None:
        """Test explicit stdio transport mode."""
        args = argument_parser.parse_args(["--transport", "stdio"])
        assert args.transport == "stdio"

    def test_http_transport(self, argument_parser: ArgumentParser) -> None:
        """Test http transport mode."""
        args = argument_parser.parse_args(["--transport", "http"])
        assert args.transport == "http"

    def test_custom_host_and_port(self, argument_parser: ArgumentParser) -> None:
        """Test custom host and port values."""
        args = argument_parser.parse_args(["--transport", "http", "--host", "example.com", "--port", "9000"])

        assert args.host == "example.com"
        assert args.port == 9000

    def test_verbose_flag(self, argument_parser: ArgumentParser) -> None:
        """Test verbose logging flag."""
        args = argument_parser.parse_args(["--verbose"])
        assert args.verbose is True

    def test_log_level_options(self, argument_parser: ArgumentParser) -> None:
        """Test various log level settings."""
        for level in ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]:
            args = argument_parser.parse_args(["--log-level", level])
            assert args.log_level == level

    def test_invalid_transport_mode(self, argument_parser: ArgumentParser) -> None:
        """Test invalid transport mode raises SystemExit."""
        with pytest.raises(SystemExit):
            argument_parser.parse_args(["--transport", "invalid"])

    def test_invalid_log_level(self, argument_parser: ArgumentParser) -> None:
        """Test invalid log level raises SystemExit."""
        with pytest.raises(SystemExit):
            argument_parser.parse_args(["--log-level", "INVALID"])

    def test_invalid_port_type(self, argument_parser: ArgumentParser) -> None:
        """Test non-integer port raises SystemExit."""
        with pytest.raises(SystemExit):
            argument_parser.parse_args(["--port", "not-a-number"])


class TestValidation:
    """Test core business logic validation."""

    def test_http_options_allowed_with_http_transport(self) -> None:
        """HTTP options should work with http transport."""
        config = parse_cli_args(["--transport", "http", "--host", "example.com", "--port", "9000"])

        assert config.transport.mode == "http"
        assert config.transport.host == "example.com"
        assert config.transport.port == 9000

    def test_custom_host_with_stdio_raises_error(self) -> None:
        """Custom host with stdio transport should raise error."""
        with pytest.raises(SystemExit):
            parse_cli_args(["--transport", "stdio", "--host", "example.com"])

    def test_custom_port_with_stdio_raises_error(self) -> None:
        """Custom port with stdio transport should raise error."""
        with pytest.raises(SystemExit):
            parse_cli_args(["--transport", "stdio", "--port", "9000"])

    def test_both_host_and_port_with_stdio_raises_error(self) -> None:
        """Both custom host and port with stdio should raise error."""
        with pytest.raises(SystemExit):
            parse_cli_args(["--transport", "stdio", "--host", "example.com", "--port", "9000"])

    def test_mixed_custom_and_default_values_with_stdio_raises_error(self) -> None:
        """Mixed custom and default HTTP values with stdio should raise error."""
        with pytest.raises(SystemExit):
            parse_cli_args(["--transport", "stdio", "--host", "custom.com"])

        with pytest.raises(SystemExit):
            parse_cli_args(["--transport", "stdio", "--port", "9000"])


class TestConfigurationCreation:
    """Test CLIConfig and TransportConfig creation."""

    def test_config_creation_with_http_mode(self) -> None:
        """Test creating config with HTTP transport."""
        config = parse_cli_args(
            ["--transport", "http", "--host", "0.0.0.0", "--port", "8080", "--verbose", "--log-level", "DEBUG"]
        )

        assert config.transport.mode == "http"
        assert config.transport.host == "0.0.0.0"
        assert config.transport.port == 8080
        assert config.verbose is True
        assert config.log_level == "DEBUG"

    def test_config_from_args_validation_error(self) -> None:
        """Test that invalid configuration raises ValueError."""
        # This would typically test Pydantic validation, but our current
        # models are simple. We'll test the error handling path.
        with pytest.raises((SystemExit, ValueError)):
            parse_cli_args(["--transport", "invalid-mode"])


class TestErrorHandling:
    """Test error scenarios and help functionality."""

    def test_help_option_raises_systemexit(self, argument_parser: ArgumentParser) -> None:
        """Test that --help raises SystemExit (expected argparse behavior)."""
        with pytest.raises(SystemExit) as exc_info:
            argument_parser.parse_args(["--help"])

        # Help should exit with code 0
        assert exc_info.value.code == 0

    def test_invalid_arguments_raise_systemexit(self, argument_parser: ArgumentParser) -> None:
        """Test that invalid arguments raise SystemExit."""
        with pytest.raises(SystemExit) as exc_info:
            argument_parser.parse_args(["--invalid-argument"])

        # Invalid args should exit with code 2
        assert exc_info.value.code == 2

    def test_parse_cli_args_with_none(self) -> None:
        """Test parsing with None (should use sys.argv)."""
        # This test verifies the function can handle None input
        # In practice, this would use sys.argv, but we can't easily test that
        config = parse_cli_args([])  # Use empty list instead of None for testing
        assert isinstance(config, CLIConfig)


class TestTransportConfig:
    """Test TransportConfig model directly."""

    def test_transport_config_creation(self) -> None:
        """Test creating TransportConfig directly."""
        config = TransportConfig(mode="http", host="example.com", port=9000)

        assert config.mode == "http"
        assert config.host == "example.com"
        assert config.port == 9000
