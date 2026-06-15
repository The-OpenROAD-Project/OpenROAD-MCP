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

  it("READONLY contains Tcl builtins", () => {
    expect(READONLY_PATTERNS).toContain("puts");
    expect(READONLY_PATTERNS).toContain("foreach");
    expect(READONLY_PATTERNS).toContain("set");
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
