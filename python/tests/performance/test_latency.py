"""
End-to-end latency benchmarks for OpenROAD MCP tool calls.

Requires a running OpenROAD binary (linux/amd64 only).
Runs automatically in CI via Dockerfile.test.

Addresses issue #42 question 2: "Are there any benchmarks for latency?"
"""

import asyncio
import time

import pytest

from openroad_mcp.core.manager import OpenROADManager


def percentile(data: list[float], pct: float) -> float:
    if not data:
        raise ValueError("Cannot compute percentile of an empty list")
    s = sorted(data)
    return s[min(int(len(s) * pct / 100), len(s) - 1)]


@pytest.mark.asyncio
async def test_create_session_latency() -> None:
    """Measure time to spawn an OpenROAD process."""
    manager = OpenROADManager()
    latencies = []
    try:
        for _ in range(5):
            t0 = time.perf_counter()
            session_id = await manager.create_session()
            latencies.append((time.perf_counter() - t0) * 1000)
            await manager.terminate_session(session_id)
        p50 = percentile(latencies, 50)
        p95 = percentile(latencies, 95)
        print(f"\ncreate_session: p50={p50:.1f}ms p95={p95:.1f}ms")
        assert p95 < 10000, f"Session spawn p95={p95:.1f}ms exceeds 10s budget"
    finally:
        await manager.cleanup_all()


@pytest.mark.asyncio
async def test_fast_command_latency() -> None:
    """Measure round-trip latency for a fast TCL command."""
    manager = OpenROADManager()
    try:
        session_id = await manager.create_session()
        await asyncio.sleep(0.5)  # Allow OpenROAD to finish startup
        latencies = []
        for _ in range(10):
            t0 = time.perf_counter()
            await manager.execute_command(session_id, "puts hello")
            latencies.append((time.perf_counter() - t0) * 1000)
        p50 = percentile(latencies, 50)
        p95 = percentile(latencies, 95)
        print(f"\nrun_tcl(puts): p50={p50:.1f}ms p95={p95:.1f}ms")
        assert p95 < 5000, f"p95={p95:.1f}ms exceeds 5s budget"
    finally:
        await manager.cleanup_all()
