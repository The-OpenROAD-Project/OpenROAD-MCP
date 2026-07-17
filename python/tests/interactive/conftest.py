"""Configuration for interactive tests."""

import gc
import warnings

import pytest


@pytest.fixture(autouse=True)
async def reset_manager():
    """Reset OpenROADManager singleton between tests to prevent state leakage.

    The OpenROADManager uses a singleton pattern. Without this fixture, sessions
    created in one test persist into the next, causing spurious failures and hangs
    from background asyncio tasks (reader/writer/exit-monitor) that outlive the
    test that spawned them.
    """
    from openroad_mcp.core.manager import OpenROADManager

    # Fresh singleton for every test
    OpenROADManager._instance = None

    yield

    # Tear down: clean up any sessions the test left open.
    # cleanup_all() terminates all session background tasks (reader/writer/exit-monitor).
    # Blanket asyncio.all_tasks() cancellation is intentionally avoided: it would kill
    # pytest-asyncio / anyio internal housekeeping and hide real task-leak bugs.
    instance = OpenROADManager._instance
    if instance is not None:
        try:
            await instance.cleanup_all()
        except Exception as e:
            warnings.warn(f"reset_manager teardown: cleanup_all() failed: {e}", stacklevel=2)
        OpenROADManager._instance = None

    gc.collect()


# Configure pytest to run interactive tests with shorter timeouts
def pytest_configure(config):
    """Configure pytest for interactive tests."""
    config.addinivalue_line("markers", "slow: mark test as slow running")


def pytest_collection_modifyitems(config, items):
    """Modify test collection to add appropriate markers."""
    for item in items:
        # Mark PTY and session tests as potentially slow
        if "pty" in item.name.lower() or "session" in item.name.lower():
            item.add_marker(pytest.mark.slow)
