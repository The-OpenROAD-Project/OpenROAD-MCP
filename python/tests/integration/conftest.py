"""Pytest configuration for integration tests without mocks."""

import asyncio
from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


@pytest.fixture(scope="session")
def event_loop():
    """Create an event loop for the test session."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture(scope="function")
async def mcp_client() -> AsyncGenerator[ClientSession]:
    """Fixture providing a MCP client session."""
    server_params = StdioServerParameters(command="python", args=["-m", "openroad_mcp.main"], env=None)

    try:
        async with stdio_client(server_params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                await asyncio.sleep(1.0)
                yield session
    except RuntimeError as e:
        if "cancel scope" in str(e):
            # Skip teardown exception (openroad-mcp handles their own teardown)
            pass
        else:
            raise
