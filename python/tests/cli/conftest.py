"""Test fixtures for CLI tests."""

from argparse import ArgumentParser

import pytest

from openroad_mcp.config.cli import create_argument_parser


@pytest.fixture
def argument_parser() -> ArgumentParser:
    """Create a CLI argument parser for testing."""
    return create_argument_parser()
