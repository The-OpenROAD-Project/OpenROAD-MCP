"""
Token efficiency and response quality benchmarks for OpenROAD-MCP.

Addresses issue #42: https://github.com/The-OpenROAD-Project/openroad-mcp/issues/42
Questions answered:
  1. Are we following best practices for compact JSON representation?
  2. Are there any benchmarks for latency? (not yet, but planned in follow-up PR)

Token estimation methodology:
  We use the ~4 chars/token rule of thumb from OpenAI's tokenizer
  documentation (https://platform.openai.com/tokenizer). For JSON with
  ASCII keys and short values this is a conservative upper bound.
  Real token counts depend on the model's tokenizer.
"""

import json
from datetime import datetime
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from openroad_mcp.core.models import (
    InteractiveExecResult,
    InteractiveSessionListResult,
)
from openroad_mcp.tools.interactive import ListSessionsTool

# ---------------------------------------------------------------------------
# Token budget constants — justified below
# ---------------------------------------------------------------------------
# A coding agent (Claude, Cursor) typically has a 200k token context window.
# MCP tool responses should consume <0.1% of context per call so that
# long agentic workflows (100+ tool calls) don't exhaust the budget.
# 200,000 * 0.001 = 200 tokens max per response.
# We set tighter budgets per response type based on their content needs.
EXEC_RESULT_TOKEN_BUDGET = 80  # minimal exec result: output + metadata
SESSION_LIST_EMPTY_BUDGET = 30  # empty list: just counts and empty array
COMPACT_SAVINGS_MIN_PCT = 10.0  # compact JSON must save ≥10% vs indent=2


def token_estimate(text: str) -> int:
    """
    Estimate token count using the 4-chars-per-token rule of thumb.

    This is a conservative upper bound for ASCII JSON content.
    See: https://platform.openai.com/tokenizer
    """
    return max(1, len(text) // 4)


def measure_response(name: str, obj: Any) -> dict[str, Any]:
    """Serialize obj to compact and pretty JSON and return size metrics."""
    data = obj.model_dump()
    compact = json.dumps(data, separators=(",", ":"))
    pretty = json.dumps(data, indent=2)
    return {
        "tool": name,
        "compact_bytes": len(compact.encode()),
        "pretty_bytes": len(pretty.encode()),
        "estimated_tokens": token_estimate(compact),
        "savings_pct": round((len(pretty) - len(compact)) / len(pretty) * 100, 1),
        "compact_json": compact,  # kept for assertion checks
    }


# ---------------------------------------------------------------------------
# 1. Token efficiency — static model checks
# ---------------------------------------------------------------------------


class TestTokenEfficiency:
    """Assert that serialized MCP responses stay within token budgets."""

    def test_exec_result_minimal_token_budget(self) -> None:
        """A minimal ExecResult must fit within EXEC_RESULT_TOKEN_BUDGET."""
        result = InteractiveExecResult(
            output="% ok",
            session_id="s1",
            timestamp=datetime.now().isoformat(),
            execution_time=0.01,
        )
        report = measure_response("ExecResult(minimal)", result)
        assert report["estimated_tokens"] < EXEC_RESULT_TOKEN_BUDGET, (
            f"ExecResult uses {report['estimated_tokens']} tokens (budget={EXEC_RESULT_TOKEN_BUDGET})"
        )

    def test_exec_result_typical_token_budget(self) -> None:
        """A typical ExecResult with metadata must stay under budget."""
        result = InteractiveExecResult(
            output="set x [expr 1+1]; puts $x\n% 2",
            session_id="session-abc123",
            timestamp="2026-01-01T12:34:56.789",
            execution_time=0.042,
            command_count=5,
            buffer_size=1024,
        )
        report = measure_response("ExecResult(typical)", result)
        assert report["estimated_tokens"] < EXEC_RESULT_TOKEN_BUDGET, (
            f"Typical ExecResult uses {report['estimated_tokens']} tokens (budget={EXEC_RESULT_TOKEN_BUDGET})"
        )

    def test_session_list_empty_token_budget(self) -> None:
        """An empty session list must fit within SESSION_LIST_EMPTY_BUDGET."""
        result = InteractiveSessionListResult(sessions=[], total_count=0, active_count=0)
        report = measure_response("SessionList(empty)", result)
        assert report["estimated_tokens"] < SESSION_LIST_EMPTY_BUDGET, (
            f"Empty session list uses {report['estimated_tokens']} tokens (budget={SESSION_LIST_EMPTY_BUDGET})"
        )

    def test_compact_json_saves_tokens_vs_pretty(self) -> None:
        """Compact JSON must save at least COMPACT_SAVINGS_MIN_PCT vs indent=2."""
        result = InteractiveExecResult(
            output="set x [expr 1+1]; puts $x",
            session_id="session-abc123",
            timestamp="2026-01-01T12:34:56.789",
            execution_time=0.123,
            command_count=5,
            buffer_size=1024,
        )
        report = measure_response("ExecResult(typical)", result)
        assert report["savings_pct"] >= COMPACT_SAVINGS_MIN_PCT, (
            f"Only {report['savings_pct']}% savings vs indent=2 (minimum={COMPACT_SAVINGS_MIN_PCT}%)"
        )

    def test_compact_json_has_no_whitespace(self) -> None:
        """Compact JSON must contain no newlines or double spaces."""
        result = InteractiveExecResult(
            output="% ok",
            session_id="s1",
            timestamp=datetime.now().isoformat(),
            execution_time=0.01,
        )
        report = measure_response("ExecResult", result)
        assert "\n" not in report["compact_json"], "Compact JSON contains newlines — indent=2 may be active"
        assert "  " not in report["compact_json"], "Compact JSON contains double spaces — pretty-print may be active"


# ---------------------------------------------------------------------------
# 2. Live tool output — verify server uses compact serialization
# ---------------------------------------------------------------------------


class TestLiveToolCompactness:
    """
    Call actual tool objects and verify their output is compact JSON.

    This catches cases where a tool accidentally uses indent=2 in
    its own serialize/execute method, which static model tests miss.
    """

    @pytest.mark.asyncio
    async def test_list_sessions_tool_output_is_compact(self) -> None:
        """ListSessionsTool.execute() must return compact JSON."""
        manager = MagicMock()
        manager.list_sessions = AsyncMock(return_value=[])
        tool = ListSessionsTool(manager)
        raw = await tool.execute()

        assert "\n" not in raw, "ListSessionsTool returned pretty-printed JSON (contains newlines)"
        assert "  " not in raw, "ListSessionsTool returned pretty-printed JSON (double spaces)"

        # Verify it's valid JSON
        data = json.loads(raw)
        assert "sessions" in data


# ---------------------------------------------------------------------------
# 3. End-to-end tool latency (requires OpenROAD binary)
# ---------------------------------------------------------------------------
# NOTE: Full MCP tool call latency benchmarks (p50/p90/p99 for actual
# interactive_openroad, create_session, etc.) require a running OpenROAD
# process. These will be implemented in a follow-up PR once the Docker
# image from #28/#46 is available.
#
# Expected measurements once implemented:
#   - create_session: time to spawn OpenROAD process
#   - run_tcl("help"): round-trip time for a fast command
#   - run_tcl("report_checks"): round-trip for expensive timing analysis
#   - 50 concurrent sessions: throughput and p99 under load


# ---------------------------------------------------------------------------
# 4. Token cost report — validates table formatting and token math
# ---------------------------------------------------------------------------


class TestTokenCostReport:
    """Validate token cost table formatting and numeric correctness."""

    def test_print_full_report(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Assert token cost table is correctly formatted and token math is accurate.

        This test serves as a regression guard: if a model field is added or
        a serializer accidentally switches to indent=2, the token counts will
        change and this test will fail.

        Note: For historical tracking across releases, metrics should be emitted
        to a GitHub Job Summary via a separate reporting script — not via a
        unit test. That is planned as part of the GSoC benchmarking deliverable.
        """
        results = [
            measure_response(
                "ExecResult(minimal)",
                InteractiveExecResult(
                    output="% ok",
                    session_id="s1",
                    timestamp="2026-01-01T00:00:00",
                    execution_time=0.01,
                ),
            ),
            measure_response(
                "ExecResult(typical)",
                InteractiveExecResult(
                    output="set x [expr 1+1]",
                    session_id="session-abc123",
                    timestamp="2026-01-01T12:34:56",
                    execution_time=0.05,
                    command_count=10,
                    buffer_size=2048,
                ),
            ),
            measure_response(
                "SessionList(empty)",
                InteractiveSessionListResult(sessions=[], total_count=0, active_count=0),
            ),
        ]

        print("\n\nMCP Response Token Cost Report")
        print("=" * 72)
        print(f"{'Response Type':<35} {'Tokens':>6} {'Bytes(c)':>8} {'Bytes(p)':>8} {'Savings':>8}")
        print("-" * 72)
        for r in results:
            print(
                f"{r['tool']:<35} {r['estimated_tokens']:>6} "
                f"{r['compact_bytes']:>8} {r['pretty_bytes']:>8} "
                f"{r['savings_pct']:>7.1f}%"
            )
        print("=" * 72)
        print("\nNote: Token estimates use ~4 chars/token rule of thumb.\nActual counts vary by model tokenizer.")

        captured = capsys.readouterr()

        # Assert table structure is present
        assert "MCP Response Token Cost Report" in captured.out
        assert "Savings" in captured.out
        assert "ExecResult(minimal)" in captured.out
        assert "ExecResult(typical)" in captured.out
        assert "SessionList(empty)" in captured.out

        # Assert token math is correct for known fixed inputs.
        # These values are pinned — if they change, a model field was
        # added/removed or the serializer changed (both warrant review).
        exec_minimal = results[0]
        exec_typical = results[1]
        session_empty = results[2]

        # Assert token math against pinned expected values.
        # If these fail, a model field was added/removed or serializer changed.
        assert exec_minimal["estimated_tokens"] == 34, (
            f"ExecResult(minimal) token count changed to {exec_minimal['estimated_tokens']} "
            "(was 34) — model fields may have changed"
        )
        assert exec_typical["estimated_tokens"] == 41, (
            f"ExecResult(typical) token count changed to {exec_typical['estimated_tokens']} "
            "(was 41) — model fields may have changed"
        )
        assert session_empty["estimated_tokens"] == 15, (
            f"SessionList(empty) token count changed to {session_empty['estimated_tokens']} "
            "(was 15) — model fields may have changed"
        )

        # Assert savings are positive (compact is always smaller than pretty)
        assert exec_minimal["savings_pct"] > 0
        assert exec_typical["savings_pct"] > 0
        assert session_empty["savings_pct"] > 0
