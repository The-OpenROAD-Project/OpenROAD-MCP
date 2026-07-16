"""Tests for the command filter security feature."""

from unittest.mock import AsyncMock, patch

import pytest

from openroad_mcp.config.command_whitelist import (
    BLOCKED_COMMANDS,
    EXEC_ONLY_PATTERNS,
    READONLY_PATTERNS,
    _extract_verb,
    is_command_allowed,
    is_exec_command,
    is_query_command,
)
from openroad_mcp.tools.interactive import ExecShellTool, QueryShellTool

# ── _extract_verb ─────────────────────────────────────────────────────────────


class TestExtractVerb:
    def test_simple_command(self):
        assert _extract_verb("report_checks") == "report_checks"

    def test_command_with_args(self):
        assert _extract_verb("report_checks -path_delay max") == "report_checks"

    def test_leading_whitespace(self):
        assert _extract_verb("   get_nets  *") == "get_nets"

    def test_empty_string(self):
        assert _extract_verb("") is None

    def test_blank_whitespace(self):
        assert _extract_verb("   ") is None

    def test_comment_line(self):
        assert _extract_verb("# this is a comment") is None

    def test_comment_with_leading_whitespace(self):
        assert _extract_verb("  # comment") is None

    def test_dollar_substitution(self):
        # $-prefixed tokens are no longer silently skipped; the verb is returned
        # so the allowlist can reject it.
        assert _extract_verb("$variable") == "$variable"

    def test_bracket_expression(self):
        # [-prefixed tokens are no longer silently skipped; the verb is returned
        # so the allowlist can reject it.
        assert _extract_verb("[report_wns]") == "[report_wns]"

    def test_trailing_semicolon(self):
        assert _extract_verb("puts;") == "puts"


# ── Pattern set membership ────────────────────────────────────────────────────


class TestPatternSets:
    def test_readonly_contains_report(self):
        assert "report_*" in READONLY_PATTERNS

    def test_readonly_contains_get(self):
        assert "get_*" in READONLY_PATTERNS

    def test_readonly_contains_check(self):
        assert "check_*" in READONLY_PATTERNS

    def test_readonly_contains_tcl_builtins(self):
        assert "puts" in READONLY_PATTERNS
        assert "foreach" in READONLY_PATTERNS
        assert "set" in READONLY_PATTERNS

    def test_exec_only_contains_set_star(self):
        assert "set_*" in EXEC_ONLY_PATTERNS

    def test_exec_only_contains_read_star(self):
        assert "read_*" in EXEC_ONLY_PATTERNS

    def test_exec_only_contains_write_star(self):
        assert "write_*" in EXEC_ONLY_PATTERNS

    def test_exec_only_contains_flow_commands(self):
        assert "global_placement" in EXEC_ONLY_PATTERNS
        assert "detailed_route" in EXEC_ONLY_PATTERNS

    def test_exec_only_does_not_contain_report(self):
        assert "report_*" not in EXEC_ONLY_PATTERNS

    def test_readonly_does_not_contain_set_star(self):
        # set_* (OpenROAD setters) are exec-only; bare 'set' is a Tcl builtin
        assert "set_*" not in READONLY_PATTERNS

    def test_exec_only_contains_orfs_file_ops(self):
        # These were moved from BLOCKED_COMMANDS to EXEC_ONLY_PATTERNS (used in ORFS flows)
        for cmd in ("exec", "source", "exit", "open", "close", "file", "cd", "uplevel"):
            assert cmd in EXEC_ONLY_PATTERNS, f"{cmd!r} should be in EXEC_ONLY_PATTERNS"
            assert cmd not in BLOCKED_COMMANDS, f"{cmd!r} should not be in BLOCKED_COMMANDS"

    def test_blocked_contains_socket_and_quit(self):
        assert "socket" in BLOCKED_COMMANDS
        assert "quit" in BLOCKED_COMMANDS


# ── is_query_command ──────────────────────────────────────────────────────────


class TestIsQueryCommand:
    def test_report_allowed(self):
        assert is_query_command("report_checks -path_delay max") == (True, None)

    def test_get_allowed(self):
        assert is_query_command("get_nets *") == (True, None)

    def test_check_allowed(self):
        assert is_query_command("check_placement") == (True, None)

    def test_sta_allowed(self):
        assert is_query_command("sta") == (True, None)

    def test_help_allowed(self):
        assert is_query_command("help") == (True, None)

    def test_puts_allowed(self):
        assert is_query_command("puts hello") == (True, None)

    def test_tcl_set_variable_allowed(self):
        # bare 'set' is Tcl variable assignment — in READONLY_PATTERNS as a builtin
        assert is_query_command("set x 42") == (True, None)

    def test_exec_only_set_star_blocked(self):
        # set_clock_period is in EXEC_ONLY_PATTERNS
        allowed, verb = is_query_command("set_clock_period -name clk 2.0")
        assert allowed is False
        assert verb == "set_clock_period"

    def test_exec_only_read_db_blocked(self):
        allowed, verb = is_query_command("read_db /path/to/design.odb")
        assert allowed is False
        assert verb == "read_db"

    def test_exec_only_write_db_blocked(self):
        allowed, verb = is_query_command("write_db /out/design.odb")
        assert allowed is False
        assert verb == "write_db"

    def test_exec_only_flow_command_blocked(self):
        allowed, verb = is_query_command("global_placement")
        assert allowed is False
        assert verb == "global_placement"

    def test_blocked_exec_denied(self):
        allowed, verb = is_query_command("exec ls -la")
        assert allowed is False
        assert verb == "exec"

    def test_unknown_command_blocked_as_exec_only(self):
        # Unknown commands are treated as exec-only
        allowed, verb = is_query_command("pdngen")
        assert allowed is False
        assert verb == "pdngen"

    def test_comment_allowed(self):
        assert is_query_command("# comment") == (True, None)

    def test_empty_allowed(self):
        assert is_query_command("") == (True, None)

    def test_multiline_all_readonly(self):
        cmd = "report_checks\nreport_wns\nget_nets *"
        assert is_query_command(cmd) == (True, None)

    def test_multiline_mixed_blocked(self):
        cmd = "report_checks\nglobal_placement"
        allowed, verb = is_query_command(cmd)
        assert allowed is False
        assert verb == "global_placement"

    def test_bracket_exec_rejected_by_query(self):
        # "[exec ls]" must not bypass the allowlist via the old early-return path.
        allowed, verb = is_query_command("[exec ls]")
        assert allowed is False
        assert verb == "[exec"

    def test_dollar_cmd_rejected_by_query(self):
        # "$cmd" must not bypass the allowlist via the old early-return path.
        allowed, verb = is_query_command("$cmd")
        assert allowed is False
        assert verb == "$cmd"


# ── is_exec_command ───────────────────────────────────────────────────────────


class TestIsExecCommand:
    def test_exec_only_set_clock_period_allowed(self):
        assert is_exec_command("set_clock_period -name clk 2.0") == (True, None)

    def test_exec_only_create_clock_allowed(self):
        assert is_exec_command("create_clock -name clk -period 2.0 [get_ports clk]") == (True, None)

    def test_exec_only_read_db_allowed(self):
        assert is_exec_command("read_db /path/to/design.odb") == (True, None)

    def test_exec_only_write_db_allowed(self):
        assert is_exec_command("write_db /out/design.odb") == (True, None)

    def test_exec_only_flow_command_allowed(self):
        assert is_exec_command("global_placement") == (True, None)

    def test_readonly_report_allowed(self):
        # report_* is read-only but exec tool is allow-by-default
        assert is_exec_command("report_wns") == (True, None)

    def test_readonly_get_allowed(self):
        assert is_exec_command("get_nets *") == (True, None)

    def test_puts_allowed(self):
        assert is_exec_command("puts hello") == (True, None)

    def test_foreach_allowed(self):
        assert is_exec_command("foreach net [get_nets *] { puts $net }") == (True, None)

    def test_unknown_command_allowed(self):
        # Unknown commands pass; Tcl rejects them if invalid
        assert is_exec_command("pdngen") == (True, None)

    def test_exec_allowed(self):
        # exec moved to EXEC_ONLY_PATTERNS (used in ORFS to call Yosys, KLayout, etc.)
        assert is_exec_command("exec yosys $::env(SCRIPTS_DIR)/synth.tcl") == (True, None)

    def test_source_allowed(self):
        # source moved to EXEC_ONLY_PATTERNS (primary ORFS script-loading mechanism)
        assert is_exec_command("source $::env(SCRIPTS_DIR)/load.tcl") == (True, None)

    def test_exit_allowed(self):
        # exit moved to EXEC_ONLY_PATTERNS (used in ORFS error handlers)
        assert is_exec_command("exit 1") == (True, None)

    def test_open_close_allowed(self):
        assert is_exec_command("open /tmp/report.log w") == (True, None)
        assert is_exec_command("close $fh") == (True, None)

    def test_file_ops_allowed(self):
        assert is_exec_command("file mkdir /results/6_final") == (True, None)

    def test_socket_blocked(self):
        # socket stays in BLOCKED_COMMANDS — no legitimate ORFS use
        allowed, verb = is_exec_command("socket tcp localhost 8080")
        assert allowed is False
        assert verb == "socket"

    def test_quit_blocked(self):
        allowed, verb = is_exec_command("quit")
        assert allowed is False
        assert verb == "quit"

    def test_multiline_all_allowed(self):
        cmd = "read_db design.odb\nglobal_placement\nwrite_db out.odb"
        assert is_exec_command(cmd) == (True, None)

    def test_multiline_blocked_one(self):
        cmd = "global_placement\nsocket tcp localhost"
        allowed, verb = is_exec_command(cmd)
        assert allowed is False
        assert verb == "socket"


# ── is_command_allowed (backward compat alias for is_exec_command) ────────────


class TestIsCommandAllowed:
    def test_report_checks_allowed(self):
        assert is_command_allowed("report_checks -path_delay max") == (True, None)

    def test_get_nets_allowed(self):
        assert is_command_allowed("get_nets *") == (True, None)

    def test_read_db_allowed(self):
        assert is_command_allowed("read_db /path/to/design.odb") == (True, None)

    def test_write_db_allowed(self):
        assert is_command_allowed("write_db /out/design.odb") == (True, None)

    def test_set_clock_period_allowed(self):
        assert is_command_allowed("set_clock_period -name clk 2.0") == (True, None)

    def test_flow_command_allowed(self):
        assert is_command_allowed("global_placement") == (True, None)

    def test_puts_allowed(self):
        assert is_command_allowed("puts hello") == (True, None)

    def test_unknown_command_allowed(self):
        assert is_command_allowed("pdngen") == (True, None)

    def test_exec_allowed(self):
        # exec is now exec-only (ORFS use), not hard-blocked
        assert is_command_allowed("exec yosys synth.tcl") == (True, None)

    def test_source_allowed(self):
        assert is_command_allowed("source $::env(SCRIPTS_DIR)/load.tcl") == (True, None)

    def test_exit_allowed(self):
        assert is_command_allowed("exit 1") == (True, None)

    def test_socket_blocked(self):
        allowed, verb = is_command_allowed("socket tcp localhost 8080")
        assert allowed is False
        assert verb == "socket"

    def test_multi_statement_all_allowed(self):
        cmd = "set x 1; report_wns; puts $x"
        assert is_command_allowed(cmd) == (True, None)

    def test_multi_statement_one_blocked(self):
        cmd = "global_placement\nsocket tcp localhost"
        allowed, verb = is_command_allowed(cmd)
        assert allowed is False
        assert verb == "socket"

    def test_blocklist_takes_priority(self):
        assert "socket" in BLOCKED_COMMANDS
        allowed, verb = is_command_allowed("socket tcp localhost")
        assert allowed is False
        assert verb == "socket"


# ── QueryShellTool filter enforcement ─────────────────────────────────────────


@pytest.mark.asyncio
class TestQueryShellToolFilter:
    @pytest.fixture
    def mock_manager(self):
        return AsyncMock()

    @pytest.fixture
    def tool(self, mock_manager):
        return QueryShellTool(mock_manager)

    async def test_readonly_command_executes(self, tool, mock_manager):
        from openroad_mcp.core.models import InteractiveExecResult

        mock_manager.execute_command.return_value = InteractiveExecResult(
            output="wns = -0.1",
            session_id="s1",
            timestamp="2024-01-01T00:00:00",
            execution_time=0.05,
            command_count=1,
        )
        result = await tool.execute("report_wns", session_id="s1")
        mock_manager.execute_command.assert_called_once()
        assert "wns" in result

    async def test_exec_only_command_blocked(self, tool, mock_manager):
        result = await tool.execute("global_placement", session_id="s1")
        mock_manager.execute_command.assert_not_called()
        assert "CommandBlocked" in result
        assert "global_placement" in result

    async def test_blocked_command_denied(self, tool, mock_manager):
        result = await tool.execute("exec ls -la", session_id="s1")
        mock_manager.execute_command.assert_not_called()
        assert "CommandBlocked" in result
        assert "exec" in result

    async def test_unknown_command_blocked_as_exec_only(self, tool, mock_manager):
        # Unknown commands are treated as exec-only — denied in query tool
        result = await tool.execute("pdngen", session_id="s1")
        mock_manager.execute_command.assert_not_called()
        assert "CommandBlocked" in result

    async def test_filter_disabled_skips_check(self, tool, mock_manager):
        from openroad_mcp.core.models import InteractiveExecResult

        mock_manager.execute_command.return_value = InteractiveExecResult(
            output="ok",
            session_id="s1",
            timestamp="2024-01-01T00:00:00",
            execution_time=0.01,
            command_count=1,
        )
        with patch("openroad_mcp.tools.interactive.settings") as mock_settings:
            mock_settings.WHITELIST_ENABLED = False
            result = await tool.execute("exec ls", session_id="s1")
            mock_manager.execute_command.assert_called_once()
            assert "ok" in result


# ── ExecShellTool filter enforcement ──────────────────────────────────────────


@pytest.mark.asyncio
class TestExecShellToolFilter:
    @pytest.fixture
    def mock_manager(self):
        return AsyncMock()

    @pytest.fixture
    def tool(self, mock_manager):
        return ExecShellTool(mock_manager)

    async def test_exec_only_command_executes(self, tool, mock_manager):
        from openroad_mcp.core.models import InteractiveExecResult

        mock_manager.execute_command.return_value = InteractiveExecResult(
            output="placement done",
            session_id="s1",
            timestamp="2024-01-01T00:00:00",
            execution_time=1.5,
            command_count=1,
        )
        result = await tool.execute("global_placement", session_id="s1")
        mock_manager.execute_command.assert_called_once()
        assert "placement" in result

    async def test_readonly_command_also_executes(self, tool, mock_manager):
        from openroad_mcp.core.models import InteractiveExecResult

        # Exec tool is allow-by-default; readonly commands are not blocked here
        mock_manager.execute_command.return_value = InteractiveExecResult(
            output="wns = -0.1",
            session_id="s1",
            timestamp="2024-01-01T00:00:00",
            execution_time=0.05,
            command_count=1,
        )
        result = await tool.execute("report_wns", session_id="s1")
        mock_manager.execute_command.assert_called_once()
        assert "wns" in result

    async def test_unknown_command_executes(self, tool, mock_manager):
        from openroad_mcp.core.models import InteractiveExecResult

        mock_manager.execute_command.return_value = InteractiveExecResult(
            output='invalid command name "pdngen"',
            session_id="s1",
            timestamp="2024-01-01T00:00:00",
            execution_time=0.01,
            command_count=1,
        )
        await tool.execute("pdngen", session_id="s1")
        mock_manager.execute_command.assert_called_once()

    async def test_hard_blocked_command_denied(self, tool, mock_manager):
        # socket is in BLOCKED_COMMANDS — denied in both tools
        result = await tool.execute("socket tcp localhost 8080", session_id="s1")
        mock_manager.execute_command.assert_not_called()
        assert "CommandBlocked" in result
        assert "socket" in result

    async def test_filter_disabled_skips_check(self, tool, mock_manager):
        from openroad_mcp.core.models import InteractiveExecResult

        mock_manager.execute_command.return_value = InteractiveExecResult(
            output="ok",
            session_id="s1",
            timestamp="2024-01-01T00:00:00",
            execution_time=0.01,
            command_count=1,
        )
        with patch("openroad_mcp.tools.interactive.settings") as mock_settings:
            mock_settings.WHITELIST_ENABLED = False
            result = await tool.execute("socket tcp localhost", session_id="s1")
            mock_manager.execute_command.assert_called_once()
            assert "ok" in result
