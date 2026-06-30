import { describe, it, expect } from "vitest";
import {
  BLOCKED_COMMANDS,
  EXEC_ONLY_PATTERNS,
  READONLY_PATTERNS,
  extractVerb,
  isCommandAllowed,
  isExecCommand,
  isQueryCommand,
} from "../../src/config/command_whitelist.js";

// extractVerb

describe("extractVerb", () => {
  it("returns a simple command", () => {
    expect(extractVerb("report_checks")).toBe("report_checks");
  });

  it("returns only the first token for a command with args", () => {
    expect(extractVerb("report_checks -path_delay max")).toBe("report_checks");
  });

  it("strips leading whitespace", () => {
    expect(extractVerb("   get_nets  *")).toBe("get_nets");
  });

  it("returns null for an empty string", () => {
    expect(extractVerb("")).toBeNull();
  });

  it("returns null for blank whitespace", () => {
    expect(extractVerb("   ")).toBeNull();
  });

  it("returns null for a comment line", () => {
    expect(extractVerb("# this is a comment")).toBeNull();
  });

  it("returns null for a comment with leading whitespace", () => {
    expect(extractVerb("  # comment")).toBeNull();
  });

  it("returns $-prefixed tokens as-is for rejection", () => {
    expect(extractVerb("$variable")).toBe("$variable");
  });

  it("returns [-prefixed tokens as-is for rejection", () => {
    expect(extractVerb("[report_wns]")).toBe("[report_wns]");
  });

  it("strips a trailing semicolon", () => {
    expect(extractVerb("puts;")).toBe("puts");
  });
});

// Pattern set membership

describe("pattern sets", () => {
  it("READONLY contains report/get/check globs", () => {
    expect(READONLY_PATTERNS).toContain("report_*");
    expect(READONLY_PATTERNS).toContain("get_*");
    expect(READONLY_PATTERNS).toContain("check_*");
  });

  it("READONLY contains safe Tcl builtins", () => {
    expect(READONLY_PATTERNS).toContain("puts");
    expect(READONLY_PATTERNS).toContain("set");
    expect(READONLY_PATTERNS).toContain("expr");
  });

  it("READONLY excludes body-eval builtins (if/for/foreach/while/proc/catch/namespace)", () => {
    for (const verb of ["if", "for", "foreach", "while", "proc", "catch", "namespace", "uplevel"]) {
      expect(READONLY_PATTERNS).not.toContain(verb);
    }
  });

  it("EXEC_ONLY contains set_*/read_*/write_* globs", () => {
    expect(EXEC_ONLY_PATTERNS).toContain("set_*");
    expect(EXEC_ONLY_PATTERNS).toContain("read_*");
    expect(EXEC_ONLY_PATTERNS).toContain("write_*");
  });

  it("EXEC_ONLY contains flow commands", () => {
    expect(EXEC_ONLY_PATTERNS).toContain("global_placement");
    expect(EXEC_ONLY_PATTERNS).toContain("detailed_route");
  });

  it("EXEC_ONLY does not contain report_*", () => {
    expect(EXEC_ONLY_PATTERNS).not.toContain("report_*");
  });

  it("READONLY does not contain set_* (exec-only setter)", () => {
    expect(READONLY_PATTERNS).not.toContain("set_*");
  });

  it("ORFS file ops are exec-only, not blocked", () => {
    for (const cmd of ["exec", "source", "exit", "open", "close", "file", "cd", "uplevel"]) {
      expect(EXEC_ONLY_PATTERNS).toContain(cmd);
      expect(BLOCKED_COMMANDS.has(cmd)).toBe(false);
    }
  });

  it("BLOCKED contains all 10 OS-level commands", () => {
    for (const cmd of [
      "quit",
      "socket",
      "load",
      "glob",
      "fconfigure",
      "chan",
      "vwait",
      "rename",
      "after",
      "subst",
    ]) {
      expect(BLOCKED_COMMANDS.has(cmd)).toBe(true);
    }
    expect(BLOCKED_COMMANDS.size).toBe(10);
  });
});

// isQueryCommand

describe("isQueryCommand", () => {
  it("allows report_*", () => {
    expect(isQueryCommand("report_checks -path_delay max")).toEqual([true, null]);
  });

  it("allows get_*", () => {
    expect(isQueryCommand("get_nets *")).toEqual([true, null]);
  });

  it("allows check_*", () => {
    expect(isQueryCommand("check_placement")).toEqual([true, null]);
  });

  it("allows sta", () => {
    expect(isQueryCommand("sta")).toEqual([true, null]);
  });

  it("allows help", () => {
    expect(isQueryCommand("help")).toEqual([true, null]);
  });

  it("allows puts", () => {
    expect(isQueryCommand("puts hello")).toEqual([true, null]);
  });

  it("allows bare set (Tcl assignment)", () => {
    expect(isQueryCommand("set x 42")).toEqual([true, null]);
  });

  it("blocks set_* (exec-only)", () => {
    expect(isQueryCommand("set_clock_period -name clk 2.0")).toEqual([false, "set_clock_period"]);
  });

  it("blocks read_db (exec-only)", () => {
    expect(isQueryCommand("read_db /path/to/design.odb")).toEqual([false, "read_db"]);
  });

  it("blocks write_db (exec-only)", () => {
    expect(isQueryCommand("write_db /out/design.odb")).toEqual([false, "write_db"]);
  });

  it("blocks flow commands (exec-only)", () => {
    expect(isQueryCommand("global_placement")).toEqual([false, "global_placement"]);
  });

  it("denies blocked exec", () => {
    expect(isQueryCommand("exec ls -la")).toEqual([false, "exec"]);
  });

  it("blocks unknown commands as exec-only", () => {
    expect(isQueryCommand("pdngen")).toEqual([false, "pdngen"]);
  });

  it("allows a comment-only line", () => {
    expect(isQueryCommand("# comment")).toEqual([true, null]);
  });

  it("allows an empty command", () => {
    expect(isQueryCommand("")).toEqual([true, null]);
  });

  it("allows a multiline all-readonly command", () => {
    expect(isQueryCommand("report_checks\nreport_wns\nget_nets *")).toEqual([true, null]);
  });

  it("blocks a multiline command with one exec verb", () => {
    expect(isQueryCommand("report_checks\nglobal_placement")).toEqual([false, "global_placement"]);
  });

  it("rejects [exec ls] without allowlist bypass", () => {
    expect(isQueryCommand("[exec ls]")).toEqual([false, "[exec"]);
  });

  it("rejects $cmd without allowlist bypass", () => {
    expect(isQueryCommand("$cmd")).toEqual([false, "$cmd"]);
  });

  it("splits on semicolons and rejects the offending verb", () => {
    expect(isQueryCommand("report_wns; global_placement")).toEqual([false, "global_placement"]);
  });

  it("body-eval: blocks catch wrapping exec (finding 1)", () => {
    expect(isQueryCommand("catch { exec ls }")).toEqual([false, "catch"]);
  });

  it("body-eval: blocks if wrapping exec (finding 1)", () => {
    expect(isQueryCommand("if 1 { exec ls }")).toEqual([false, "if"]);
  });

  it("body-eval: blocks foreach wrapping exec (finding 1)", () => {
    expect(isQueryCommand("foreach x {a} { exec ls }")).toEqual([false, "foreach"]);
  });

  it("bracket: blocks set x [exec ls] via bracket scan (finding 2)", () => {
    expect(isQueryCommand("set x [exec ls]")).toEqual([false, "exec"]);
  });

  it("bracket: blocks set x [::exec ls] with namespace-qualified command", () => {
    expect(isQueryCommand("set x [::exec ls]")).toEqual([false, "exec"]);
  });

  it("bracket: blocks expr {[exec ls]} via bracket scan (finding 2)", () => {
    expect(isQueryCommand("expr {[exec ls]}")).toEqual([false, "exec"]);
  });

  it("bracket: allows puts [report_wns] when bracket verb is read-only (finding 2)", () => {
    expect(isQueryCommand("puts [report_wns]")).toEqual([true, null]);
  });

  it("bracket: blocks puts [global_placement] (exec-only in bracket)", () => {
    expect(isQueryCommand("puts [global_placement]")).toEqual([false, "global_placement"]);
  });

  it("semicolon in quoted string is not a statement separator (finding 3)", () => {
    expect(isQueryCommand('puts "hello; world"')).toEqual([true, null]);
  });

  it("semicolon inside braces is not a statement separator (finding 3)", () => {
    expect(isQueryCommand("report_checks {a; b}")).toEqual([true, null]);
  });

  it("allows a bracket inside a comment line (never executed)", () => {
    expect(isQueryCommand("# harmless [exec ls]")).toEqual([true, null]);
  });

  it("allows a comment with a bracket after a readonly statement", () => {
    expect(isQueryCommand("report_wns\n# harmless [exec ls]")).toEqual([true, null]);
  });

  it("still blocks a bracket when # is a mid-statement arg, not a comment", () => {
    expect(isQueryCommand("report_checks # [exec ls]")).toEqual([false, "exec"]);
  });

  it("unbalanced close brace cannot hide a trailing exec (depth clamp)", () => {
    expect(isQueryCommand("report_wns }; exec ls")).toEqual([false, "exec"]);
  });

  it("blocks a backslash-escaped exec-only verb (\\glob -> glob)", () => {
    expect(isQueryCommand("\\glob *")).toEqual([false, "glob"]);
  });

  it("blocks a backslash-escaped command in a bracket substitution", () => {
    expect(isQueryCommand("puts [\\exec ls]")).toEqual([false, "exec"]);
  });

  it("blocks a variable-substituted command in a bracket ([$x] -> exec at runtime)", () => {
    expect(isQueryCommand("set x exec; puts [$x ls]")).toEqual([false, "$x"]);
  });

  it("blocks a nested command substitution as the bracket command ([[...] ...])", () => {
    expect(isQueryCommand("puts [[set x exec] ls]")).toEqual([false, "[set"]);
  });

  it("still allows a substituted argument that is a variable ([get_cells $x])", () => {
    expect(isQueryCommand("puts [get_property [get_cells $x] area]")).toEqual([true, null]);
  });

  it("mid-word quote is literal and cannot hide a trailing exec", () => {
    expect(isQueryCommand('set x a"b ; exec ls')).toEqual([false, "exec"]);
  });
});

// isExecCommand

describe("isExecCommand", () => {
  it("allows set_clock_period", () => {
    expect(isExecCommand("set_clock_period -name clk 2.0")).toEqual([true, null]);
  });

  it("allows create_clock", () => {
    expect(isExecCommand("create_clock -name clk -period 2.0 [get_ports clk]")).toEqual([true, null]);
  });

  it("allows read_db / write_db", () => {
    expect(isExecCommand("read_db /path/to/design.odb")).toEqual([true, null]);
    expect(isExecCommand("write_db /out/design.odb")).toEqual([true, null]);
  });

  it("allows flow commands", () => {
    expect(isExecCommand("global_placement")).toEqual([true, null]);
  });

  it("allows readonly commands (allow-by-default)", () => {
    expect(isExecCommand("report_wns")).toEqual([true, null]);
    expect(isExecCommand("get_nets *")).toEqual([true, null]);
  });

  it("allows puts and foreach", () => {
    expect(isExecCommand("puts hello")).toEqual([true, null]);
    expect(isExecCommand("foreach net [get_nets *] { puts $net }")).toEqual([true, null]);
  });

  it("allows unknown commands", () => {
    expect(isExecCommand("pdngen")).toEqual([true, null]);
  });

  it("allows exec / source / exit (ORFS use)", () => {
    expect(isExecCommand("exec yosys $::env(SCRIPTS_DIR)/synth.tcl")).toEqual([true, null]);
    expect(isExecCommand("source $::env(SCRIPTS_DIR)/load.tcl")).toEqual([true, null]);
    expect(isExecCommand("exit 1")).toEqual([true, null]);
  });

  it("allows open/close/file ops", () => {
    expect(isExecCommand("open /tmp/report.log w")).toEqual([true, null]);
    expect(isExecCommand("close $fh")).toEqual([true, null]);
    expect(isExecCommand("file mkdir /results/6_final")).toEqual([true, null]);
  });

  it("blocks socket", () => {
    expect(isExecCommand("socket tcp localhost 8080")).toEqual([false, "socket"]);
  });

  it("blocks quit", () => {
    expect(isExecCommand("quit")).toEqual([false, "quit"]);
  });

  it("allows a multiline all-allowed command", () => {
    expect(isExecCommand("read_db design.odb\nglobal_placement\nwrite_db out.odb")).toEqual([true, null]);
  });

  it("blocks a multiline command with one blocked verb", () => {
    expect(isExecCommand("global_placement\nsocket tcp localhost")).toEqual([false, "socket"]);
  });

  it("unbalanced close brace cannot hide a trailing quit (depth clamp)", () => {
    expect(isExecCommand("set x } ; quit")).toEqual([false, "quit"]);
  });

  it("blocks a backslash-escaped verb (\\socket -> socket)", () => {
    expect(isExecCommand("\\socket localhost 1")).toEqual([false, "socket"]);
    expect(isExecCommand("\\quit")).toEqual([false, "quit"]);
    expect(isExecCommand("\\load /tmp/x")).toEqual([false, "load"]);
  });

  it("blocks a hex/octal-escaped verb (\\x73ocket / \\163ocket -> socket)", () => {
    expect(isExecCommand("\\x73ocket localhost 1")).toEqual([false, "socket"]);
    expect(isExecCommand("\\163ocket localhost 1")).toEqual([false, "socket"]);
  });
});

// isCommandAllowed (backward-compat alias)

describe("isCommandAllowed", () => {
  it("mirrors isExecCommand for allowed commands", () => {
    expect(isCommandAllowed("report_checks -path_delay max")).toEqual([true, null]);
    expect(isCommandAllowed("read_db /path/to/design.odb")).toEqual([true, null]);
    expect(isCommandAllowed("set_clock_period -name clk 2.0")).toEqual([true, null]);
    expect(isCommandAllowed("global_placement")).toEqual([true, null]);
    expect(isCommandAllowed("pdngen")).toEqual([true, null]);
    expect(isCommandAllowed("exec yosys synth.tcl")).toEqual([true, null]);
  });

  it("allows a multi-statement command with semicolons", () => {
    expect(isCommandAllowed("set x 1; report_wns; puts $x")).toEqual([true, null]);
  });

  it("blocks socket and gives it priority", () => {
    expect(isCommandAllowed("socket tcp localhost 8080")).toEqual([false, "socket"]);
    expect(isCommandAllowed("global_placement\nsocket tcp localhost")).toEqual([false, "socket"]);
  });
});

// splitlines() parity — bypass regression tests

describe("line-boundary splitting (Python splitlines parity)", () => {
  // Each of these separators must be treated as a statement boundary so that
  // a blocked verb after the separator is not silently skipped.

  it("blocks quit hidden after \\r (CR alone)", () => {
    expect(isExecCommand("report_checks\rquit")).toEqual([false, "quit"]);
  });

  it("blocks quit hidden after \\r\\n (CRLF)", () => {
    expect(isExecCommand("report_checks\r\nquit")).toEqual([false, "quit"]);
  });

  it("blocks quit hidden after \\v (vertical tab)", () => {
    expect(isExecCommand("report_checks\vquit")).toEqual([false, "quit"]);
  });

  it("blocks quit hidden after \\f (form feed)", () => {
    expect(isExecCommand("report_checks\fquit")).toEqual([false, "quit"]);
  });

  it("blocks quit hidden after \\x85 (NEL)", () => {
    expect(isExecCommand("report_checks\x85quit")).toEqual([false, "quit"]);
  });

  it("blocks quit hidden after \\u2028 (line separator)", () => {
    expect(isExecCommand("report_checks quit")).toEqual([false, "quit"]);
  });

  it("blocks quit hidden after \\u2029 (paragraph separator)", () => {
    expect(isExecCommand("report_checks quit")).toEqual([false, "quit"]);
  });

  it("query tool also blocks exec-only verb hidden after \\r", () => {
    expect(isQueryCommand("report_checks\rglobal_placement")).toEqual([false, "global_placement"]);
  });
});

// minimatch vs fnmatch parity

describe("glob parity (minimatch vs fnmatch)", () => {
  it("matches star-suffix against the empty remainder", () => {
    // report_ / set_ / read_ match report_* / set_* / read_* (star matches empty)
    expect(isQueryCommand("report_")).toEqual([true, null]);
    expect(isExecCommand("set_")).toEqual([true, null]);
    expect(isExecCommand("read_")).toEqual([true, null]);
  });

  it("is case-sensitive like POSIX fnmatch on verbs", () => {
    // Report_Checks (capitalized) does not match report_* and is unknown -> blocked in query
    expect(isQueryCommand("Report_Checks")).toEqual([false, "Report_Checks"]);
  });
});
