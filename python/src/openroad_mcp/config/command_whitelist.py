"""Command filter for OpenROAD PTY session security.

Prevents execution of dangerous OS-level Tcl commands by AI agents.

Three-tier design:

  BLOCKED_COMMANDS    — denied in both tools (OS-level Tcl built-ins that can
                        escape the EDA sandbox)

  EXEC_ONLY_PATTERNS  — explicitly known state-modifying commands; denied in
                        the query tool, allowed in the exec tool

  READONLY_PATTERNS   — explicitly known safe read-only commands; allowed in
                        both tools

  Unknown commands    — treated as exec-only: denied in the query tool,
                        allowed in the exec tool (they will fail at the Tcl
                        level if invalid)
"""

import fnmatch

from ..utils.logging import get_logger

logger = get_logger("command_whitelist")

# Blocked commands — denied in both query and exec tools.
BLOCKED_COMMANDS: frozenset[str] = frozenset(
    [
        "quit",  # Terminate the OpenROAD process (ORFS uses exit instead)
        "socket",  # Network connections
        "load",  # Load compiled C extensions into the interpreter
        "glob",  # Filesystem enumeration
        "fconfigure",  # I/O channel configuration
        "chan",  # Channel operations
        "vwait",  # Block the event loop
        "rename",  # Renames/removes commands, can bypass top-level checks
        "after",  # Schedules arbitrary code execution
        "subst",  # Performs substitutions that can invoke arbitrary commands
    ]
)

# Exec-Only commands - denied in the query, allowed in exec tool.
# Unknown commands are implicitly exec-only and do not need to appear here.
EXEC_ONLY_PATTERNS: tuple[str, ...] = (
    # ── ORFS file and process operations (used in synth.tcl, util.tcl, etc.) ──
    "exec",  # Run external tools (Yosys, KLayout, Python helpers)
    "source",  # Load Tcl scripts (primary ORFS script-loading mechanism)
    "exit",  # Process exit (used in ORFS error handlers)
    "open",  # Open file handles (reports, SDC files, metrics)
    "close",  # Close file handles
    "file",  # Filesystem ops: mkdir, delete, link, copy
    "cd",  # Change working directory (used in platform setup scripts)
    "uplevel",  # Evaluate in parent stack frame (used by ORFS log_cmd)
    # ── OpenROAD constraints / design setup ──────────────────────────────
    "set_*",
    "create_*",
    # ── File I/O through OpenROAD wrappers ───────────────────────────────
    "read_*",
    "write_*",
    # ── OpenROAD flow commands ────────────────────────────────────────────
    "initialize_floorplan",
    "place_pins",
    "global_placement",
    "detailed_placement",
    "clock_tree_synthesis",
    "global_route",
    "detailed_route",
    "repair_design",
    "repair_timing",
    "repair_clock_nets",
    # ── OpenROAD utility ──────────────────────────────────────────────────
    "log_begin",
    "log_end",
)

# Safe Tcl built-ins — usable in both tools.
_TCL_BUILTINS: tuple[str, ...] = (
    "puts",
    "set",
    "expr",
    "if",
    "else",
    "elseif",
    "for",
    "foreach",
    "while",
    "proc",
    "return",
    "break",
    "continue",
    "list",
    "llength",
    "lindex",
    "lappend",
    "lrange",
    "lsort",
    "lsearch",
    "lreplace",
    "string",
    "regexp",
    "regsub",
    "format",
    "scan",
    "array",
    "dict",
    "catch",
    "error",
    "namespace",
    "upvar",
    "global",
    "variable",
    "concat",
    "join",
    "split",
    "incr",
    "append",
    "info",
    "unset",
)

# Read-only OpenROAD command patterns - allowed in the query tool.
READONLY_PATTERNS: tuple[str, ...] = (
    # ── OpenROAD reporting ────────────────────────────────────────────────
    "report_*",
    # ── OpenROAD design queries ───────────────────────────────────────────
    "get_*",
    # ── OpenROAD validation ───────────────────────────────────────────────
    "check_*",
    # ── OpenROAD analysis ─────────────────────────────────────────────────
    "estimate_parasitics",
    "sta",
    # ── OpenROAD utility ──────────────────────────────────────────────────
    "help",
    "version",
) + _TCL_BUILTINS


def _extract_verb(statement: str) -> str | None:
    """Return the command verb (first token) of a single Tcl statement.

    Returns None only for blank lines and comment lines.  Lines that start with
    a substitution or grouping character (``$``, ``[``, ``]``, ``{``, ``}``)
    are returned as-is so the caller can reject them via the allowlist.
    """
    stripped = statement.strip()
    if not stripped or stripped.startswith("#"):
        return None
    return stripped.split()[0].rstrip(";")


def is_query_command(command: str) -> tuple[bool, str | None]:
    """Check whether *command* is safe for the read-only query tool.

    A verb is allowed only when it is in READONLY_PATTERNS and not in
    BLOCKED_COMMANDS.  Commands in EXEC_ONLY_PATTERNS and unknown commands
    are both treated as exec-only and are rejected here.

    Known limitation: semicolons are split naively with
    ``command.replace(";", "\\n")``.  Semicolons inside Tcl braces or quoted
    strings will cause the text after the semicolon to be evaluated as a
    separate statement and may be rejected even though the original command
    is safe.
    # TODO: replace the naive splitter with a Tcl-aware parser.
    """
    for raw_line in command.replace(";", "\n").splitlines():
        verb = _extract_verb(raw_line)
        if verb is None:
            continue

        if verb in BLOCKED_COMMANDS:
            logger.warning("Blocked command '%s' (explicit blocklist)", verb)
            return False, verb

        if not any(fnmatch.fnmatch(verb, pattern) for pattern in READONLY_PATTERNS):
            if any(fnmatch.fnmatch(verb, pattern) for pattern in EXEC_ONLY_PATTERNS):
                logger.warning("Blocked command '%s' (exec-only, use the exec tool)", verb)
            else:
                logger.warning("Blocked command '%s' (unknown, treated as exec-only)", verb)
            return False, verb

    return True, None


def is_exec_command(command: str) -> tuple[bool, str | None]:
    """Check whether *command* is safe for the state-modifying exec tool.

    Blocks only BLOCKED_COMMANDS (OS-level danger).  All other commands —
    including EXEC_ONLY_PATTERNS, READONLY_PATTERNS, and unknown ones — are
    allowed; they will fail at the Tcl level if invalid.
    """
    for raw_line in command.replace(";", "\n").splitlines():
        verb = _extract_verb(raw_line)
        if verb is None:
            continue

        if verb in BLOCKED_COMMANDS:
            logger.warning("Blocked command '%s' (explicit blocklist)", verb)
            return False, verb

    return True, None


def is_command_allowed(command: str) -> tuple[bool, str | None]:
    """Check *command* against BLOCKED_COMMANDS only (allow-by-default).

    Equivalent to is_exec_command. Kept for backward compatibility.
    """
    return is_exec_command(command)
