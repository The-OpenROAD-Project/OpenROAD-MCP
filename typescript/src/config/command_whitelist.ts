/**
 * Command filter for OpenROAD PTY session security.
 *
 * Prevents execution of dangerous OS-level Tcl commands by AI agents.
 *
 * Three-tier design:
 *
 *   BLOCKED_COMMANDS    - denied in both tools (OS-level Tcl built-ins that can
 *                         escape the EDA sandbox)
 *
 *   EXEC_ONLY_PATTERNS  - explicitly known state-modifying commands; denied in
 *                         the query tool, allowed in the exec tool
 *
 *   READONLY_PATTERNS   - explicitly known safe read-only commands; allowed in
 *                         both tools
 *
 *   Unknown commands    - treated as exec-only: denied in the query tool,
 *                         allowed in the exec tool (they will fail at the Tcl
 *                         level if invalid)
 *
 * This is distinct from PtyHandler.validateCommand(), which guards the shell
 * binary/args. This module guards the Tcl statements sent to the REPL.
 */

import { minimatch } from "minimatch";
import { getLogger } from "../utils/logging.js";

const logger = getLogger("command_whitelist");

// Python uses fnmatch.fnmatch, which (unlike default glob) does not special-case
// a leading dot. `dot: true` makes minimatch's `*` match leading dots too, so
// single-token verb matching stays faithful to the Python implementation.
const MINIMATCH_OPTS = { dot: true } as const;

function matchVerb(verb: string, pattern: string): boolean {
  return minimatch(verb, pattern, MINIMATCH_OPTS);
}

// Blocked commands - denied in both query and exec tools.
export const BLOCKED_COMMANDS: ReadonlySet<string> = new Set([
  "quit", // Terminate the OpenROAD process (ORFS uses exit instead)
  "socket", // Network connections
  "load", // Load compiled C extensions into the interpreter
  "glob", // Filesystem enumeration
  "fconfigure", // I/O channel configuration
  "chan", // Channel operations
  "vwait", // Block the event loop
  "rename", // Renames/removes commands, can bypass top-level checks
  "after", // Schedules arbitrary code execution
  "subst", // Performs substitutions that can invoke arbitrary commands
]);

// Exec-only commands - denied in the query, allowed in the exec tool.
// Unknown commands are implicitly exec-only and do not need to appear here.
export const EXEC_ONLY_PATTERNS: readonly string[] = [
  // ORFS file and process operations
  "exec", // Run external tools (Yosys, KLayout, Python helpers)
  "source", // Load Tcl scripts (primary ORFS script-loading mechanism)
  "exit", // Process exit (used in ORFS error handlers)
  "open", // Open file handles (reports, SDC files, metrics)
  "close", // Close file handles
  "file", // Filesystem ops: mkdir, delete, link, copy
  "cd", // Change working directory (used in platform setup scripts)
  "uplevel", // Evaluate in parent stack frame (used by ORFS log_cmd)
  // OpenROAD constraints / design setup
  "set_*",
  "create_*",
  // File I/O through OpenROAD wrappers
  "read_*",
  "write_*",
  // OpenROAD flow commands
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
  // OpenROAD utility
  "log_begin",
  "log_end",
];

// Safe Tcl built-ins - usable in both tools.
export const _TCL_BUILTINS: readonly string[] = [
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
];

// Read-only OpenROAD command patterns - allowed in the query tool.
export const READONLY_PATTERNS: readonly string[] = [
  // OpenROAD reporting
  "report_*",
  // OpenROAD design queries
  "get_*",
  // OpenROAD validation
  "check_*",
  // OpenROAD analysis
  "estimate_parasitics",
  "sta",
  // OpenROAD utility
  "help",
  "version",
  ..._TCL_BUILTINS,
];

/**
 * Return the command verb (first token) of a single Tcl statement.
 *
 * Returns null only for blank lines and comment lines. Lines that start with a
 * substitution or grouping character (`$`, `[`, `]`, `{`, `}`) are returned
 * as-is so the caller can reject them via the allowlist.
 */
export function extractVerb(statement: string): string | null {
  const stripped = statement.trim();
  if (stripped === "" || stripped.startsWith("#")) {
    return null;
  }
  const firstToken = stripped.split(/\s+/)[0]!;
  return firstToken.replace(/;+$/, "");
}

/** Iterate the verbs of a command, mirroring Python's naive `;`->newline split. */
function* iterVerbs(command: string): Generator<string> {
  // Preserve the naive splitting behavior exactly: replace ';' with newline,
  // then split into lines. Semicolons inside Tcl braces or quoted strings are
  // not handled - this matches the Python implementation's known limitation.
  for (const rawLine of command.replace(/;/g, "\n").split("\n")) {
    const verb = extractVerb(rawLine);
    if (verb !== null) {
      yield verb;
    }
  }
}

/**
 * Check whether `command` is safe for the read-only query tool.
 *
 * A verb is allowed only when it matches READONLY_PATTERNS and is not in
 * BLOCKED_COMMANDS. Commands in EXEC_ONLY_PATTERNS and unknown commands are
 * both treated as exec-only and are rejected here.
 */
export function isQueryCommand(command: string): [boolean, string | null] {
  for (const verb of iterVerbs(command)) {
    if (BLOCKED_COMMANDS.has(verb)) {
      logger.warn(`Blocked command '${verb}' (explicit blocklist)`);
      return [false, verb];
    }

    if (!READONLY_PATTERNS.some((pattern) => matchVerb(verb, pattern))) {
      if (EXEC_ONLY_PATTERNS.some((pattern) => matchVerb(verb, pattern))) {
        logger.warn(`Blocked command '${verb}' (exec-only, use the exec tool)`);
      } else {
        logger.warn(`Blocked command '${verb}' (unknown, treated as exec-only)`);
      }
      return [false, verb];
    }
  }

  return [true, null];
}

/**
 * Check whether `command` is safe for the state-modifying exec tool.
 *
 * Blocks only BLOCKED_COMMANDS (OS-level danger). All other commands -
 * including EXEC_ONLY_PATTERNS, READONLY_PATTERNS, and unknown ones - are
 * allowed; they will fail at the Tcl level if invalid.
 */
export function isExecCommand(command: string): [boolean, string | null] {
  for (const verb of iterVerbs(command)) {
    if (BLOCKED_COMMANDS.has(verb)) {
      logger.warn(`Blocked command '${verb}' (explicit blocklist)`);
      return [false, verb];
    }
  }

  return [true, null];
}

/**
 * Check `command` against BLOCKED_COMMANDS only (allow-by-default).
 * Equivalent to isExecCommand. Kept for backward compatibility.
 */
export function isCommandAllowed(command: string): [boolean, string | null] {
  return isExecCommand(command);
}
