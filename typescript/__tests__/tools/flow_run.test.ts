import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../src/config/settings.js", () => ({
  getSettings: vi.fn(() => ({ LOG_LEVEL: "SILENT" })),
}));

import { getSettings } from "../../src/config/settings.js";
import {
  RunOrfsStageTool,
  GetOrfsJobTool,
  CancelOrfsJobTool,
  validateTarget,
  validateOverrides,
  ALLOWED_TARGETS,
} from "../../src/tools/flow_run.js";
import { FlowJobRegistry } from "../../src/core/flow_jobs.js";
import { ValidationError } from "../../src/exceptions.js";
import type { OpenROADManager } from "../../src/core/manager.js";

const stubManager = {} as unknown as OpenROADManager;
let tmpDir: string;

function setSettings(over: Record<string, unknown> = {}): void {
  (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
    LOG_LEVEL: "SILENT",
    RUN_LOG_DIR: path.join(tmpDir, "runs"),
    MAX_FLOW_JOBS: 2,
    FLOW_RUN_TIMEOUT: 3600,
    flowPath: tmpDir,
    platforms: ["nangate45"],
    designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
    ...over,
  });
}

function stub(name: string, body: string): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-run-test-"));
  fs.mkdirSync(path.join(tmpDir, "designs", "nangate45", "gcd"), { recursive: true });
  setSettings();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("validateTarget", () => {
  it("accepts the ORFS stage and clean targets", () => {
    for (const t of ["synth", "floorplan", "place", "cts", "grt", "route", "finish", "clean_cts"]) {
      expect(validateTarget(t)).toBe(t);
    }
  });

  it("rejects a target that would become a make flag", () => {
    // Without an allowlist this reaches make as an argument, not a goal.
    expect(() => validateTarget("-f/tmp/evil.mk")).toThrow(ValidationError);
    expect(() => validateTarget("--eval=$(shell id)")).toThrow(ValidationError);
  });

  it("rejects unknown and path-like targets", () => {
    expect(() => validateTarget("../../x")).toThrow(ValidationError);
    expect(() => validateTarget("install")).toThrow(ValidationError);
    expect(() => validateTarget("")).toThrow(ValidationError);
  });

  it("names what is allowed so a caller can correct itself", () => {
    expect(() => validateTarget("nope")).toThrow(/Allowed:.*cts.*route/s);
  });

  it("does not quietly allow shell-ish targets", () => {
    expect(ALLOWED_TARGETS.has("cts; id")).toBe(false);
  });
});

describe("validateOverrides", () => {
  it("accepts the knobs the study actually swept", () => {
    expect(
      validateOverrides({ PLACE_DENSITY_LB_ADDON: "0.25", CTS_CLUSTER_SIZE: "20" }),
    ).toEqual({ PLACE_DENSITY_LB_ADDON: "0.25", CTS_CLUSTER_SIZE: "20" });
  });

  it("accepts a value with spaces, which is one argv entry not a shell string", () => {
    expect(validateOverrides({ CTS_BUF_LIST: "CLKBUF_X2 CLKBUF_X4" })).toEqual({
      CTS_BUF_LIST: "CLKBUF_X2 CLKBUF_X4",
    });
  });

  it("rejects keys that are not make variable names", () => {
    expect(() => validateOverrides({ "a;b": "1" })).toThrow(/valid make variable name/);
    expect(() => validateOverrides({ lowercase: "1" })).toThrow(ValidationError);
    expect(() => validateOverrides({ "X Y": "1" })).toThrow(ValidationError);
  });

  it("rejects variables that control how make executes recipes", () => {
    // shell:false stops a shell reinterpreting a value, but make will happily
    // use an overridden SHELL to run every recipe.
    for (const key of ["SHELL", "MAKESHELL", "MAKE", "MAKEFLAGS", "PATH", "LD_PRELOAD"]) {
      expect(() => validateOverrides({ [key]: "/bin/sh" })).toThrow(/controls how make executes/);
    }
  });

  it("rejects values make would expand", () => {
    expect(() => validateOverrides({ FOO: "$(shell id)" })).toThrow(/expands these/);
    expect(() => validateOverrides({ FOO: "${HOME}" })).toThrow(ValidationError);
    expect(() => validateOverrides({ FOO: "`id`" })).toThrow(ValidationError);
  });

  it("rejects newlines, which would forge extra make arguments", () => {
    expect(() => validateOverrides({ FOO: "a\nBAR=b" })).toThrow(/newlines/);
    expect(() => validateOverrides({ FOO: "a\0b" })).toThrow(ValidationError);
  });

  it("treats no overrides as an empty set", () => {
    expect(validateOverrides(undefined)).toEqual({});
    expect(validateOverrides(null)).toEqual({});
  });
});

describe("RunOrfsStageTool", () => {
  function tool(registry: FlowJobRegistry): RunOrfsStageTool {
    return new RunOrfsStageTool(stubManager, registry);
  }

  it("runs a stage and returns the finished result inline when asked to wait", async () => {
    const registry = new FlowJobRegistry(stub("quick.sh", "echo cts done"));

    const result = JSON.parse(
      await tool(registry).execute("gcd", "cts", null, null, "base", 8),
    );

    expect(result.error).toBeNull();
    expect(result.status).toBe("succeeded");
    expect(result.platform).toBe("nangate45");
    expect(result.exit_code).toBe(0);
    expect(result.command).toContain("cts");
  });

  it("returns a job_id immediately for a long run rather than blocking", async () => {
    const registry = new FlowJobRegistry(stub("slow.sh", "sleep 300"));

    const result = JSON.parse(await tool(registry).execute("gcd", "route"));

    expect(result.status).toBe("running");
    expect(result.job_id).toHaveLength(8);
    // Deprecated gate fields stay in the result, empty.
    expect(result.gates).toEqual([]);
    expect(result.gate_summary).toBeNull();
    await registry.shutdown();
  });

  it("puts each override on the command line as its own assignment", async () => {
    const registry = new FlowJobRegistry(stub("quick.sh", "echo ok"));

    const result = JSON.parse(
      await tool(registry).execute(
        "gcd", "cts", { CTS_CLUSTER_SIZE: "20" }, null, "base", 8,
      ),
    );

    expect(result.command).toContain("CTS_CLUSTER_SIZE=20");
    expect(result.command).toContain("DESIGN_CONFIG=./designs/nangate45/gcd/config.mk");
    expect(result.overrides).toEqual({ CTS_CLUSTER_SIZE: "20" });
  });

  it("passes -n for a dry run", async () => {
    const registry = new FlowJobRegistry(stub("quick.sh", "echo ok"));

    const result = JSON.parse(
      await tool(registry).execute("gcd", "route", null, null, "base", 8, null, null, true),
    );

    expect(result.command).toContain(" -n ");
    expect(result.dry_run).toBe(true);
  });

  it("rejects a bad target before spawning anything", async () => {
    const registry = new FlowJobRegistry(stub("quick.sh", "echo ok"));

    const result = JSON.parse(await tool(registry).execute("gcd", "-f/tmp/evil.mk"));

    expect(result.error).toBe("ValidationError");
    expect(registry.size).toBe(0);
  });

  it("rejects a dangerous override before spawning anything", async () => {
    const registry = new FlowJobRegistry(stub("quick.sh", "echo ok"));

    const result = JSON.parse(
      await tool(registry).execute("gcd", "cts", { SHELL: "/bin/sh" }),
    );

    expect(result.error).toBe("ValidationError");
    expect(registry.size).toBe(0);
  });

  it("rejects an unknown design", async () => {
    const registry = new FlowJobRegistry(stub("quick.sh", "echo ok"));

    const result = JSON.parse(await tool(registry).execute("nosuchdesign", "cts"));

    expect(result.error).toBe("ValidationError");
  });

  it("rejects path traversal in design and variant", async () => {
    const registry = new FlowJobRegistry(stub("quick.sh", "echo ok"));

    expect(JSON.parse(await tool(registry).execute("..", "cts")).error).toBe("ValidationError");
    expect(
      JSON.parse(await tool(registry).execute("gcd", "cts", null, null, "../x")).error,
    ).toBe("ValidationError");
  });

  it("reports the concurrency limit rather than piling runs on", async () => {
    setSettings({ MAX_FLOW_JOBS: 1 });
    const registry = new FlowJobRegistry(stub("slow.sh", "sleep 300"));
    await tool(registry).execute("gcd", "route");

    const result = JSON.parse(await tool(registry).execute("gcd", "cts"));

    expect(result.error).toBe("FlowJobLimit");
    await registry.shutdown();
  });

  it("attaches stage metrics once a run succeeds", async () => {
    const logsDir = path.join(tmpDir, "logs", "nangate45", "gcd", "base");
    fs.mkdirSync(logsDir, { recursive: true });
    // Written by the run itself, as ORFS would: results are only attributed to
    // a job when the stage file postdates the job's start.
    const registry = new FlowJobRegistry(
      stub(
        "writes_cts.sh",
        `cat > ${path.join(logsDir, "4_1_cts.json")} <<'JSON'\n` +
          `{"cts__utilization__before__dpl": 76.7787,\n` +
          ` "cts__utilization__before__dpl": 82.1146,\n` +
          ` "cts__timing__setup__ws": -0.113089}\nJSON`,
      ),
    );

    const result = JSON.parse(
      await tool(registry).execute("gcd", "cts", null, null, "base", 8),
    );

    expect(result.stages[0].stage).toBe("4_1_cts");
    // Repeated keys survive as arrays, exactly as read_orfs_metrics returns them.
    expect(result.stages[0].metrics.cts__utilization__before__dpl).toEqual([76.7787, 82.1146]);
    expect(result.stages[0].metrics.cts__timing__setup__ws).toBe(-0.113089);
    // Deprecated gate fields stay in the result, empty: no gates are judged.
    expect(result.gates).toEqual([]);
    expect(result.gate_summary).toEqual({ total: 0, pass: 0, fail: 0, failing_errors: 0 });
  });
});

describe("GetOrfsJobTool and CancelOrfsJobTool", () => {
  it("does not report a previous run's metrics as this job's results", async () => {
    // `make` with an up-to-date target exits in milliseconds having written
    // nothing. The stage files from the last run are still on disk, and
    // returning them turns "nothing happened" into a green QoR report.
    const logsDir = path.join(tmpDir, "logs", "nangate45", "gcd", "base");
    fs.mkdirSync(logsDir, { recursive: true });
    const stale = path.join(logsDir, "4_1_cts.json");
    fs.writeFileSync(stale, `{"cts__timing__setup__ws": -0.1}`);
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(stale, old, old);
    const registry = new FlowJobRegistry(stub("noop.sh", "echo \"Nothing to be done\""));

    const result = JSON.parse(
      await new RunOrfsStageTool(stubManager, registry).execute(
        "gcd", "cts", null, null, "base", 8,
      ),
    );

    expect(result.status).toBe("succeeded");
    expect(result.stages).toEqual([]);
  });

  it("reports metrics the run did write", async () => {
    const logsDir = path.join(tmpDir, "logs", "nangate45", "gcd", "base");
    fs.mkdirSync(logsDir, { recursive: true });
    const registry = new FlowJobRegistry(
      stub("writes.sh", `echo '{"cts__timing__setup__ws": -0.1}' > ${path.join(logsDir, "4_1_cts.json")}`),
    );

    const result = JSON.parse(
      await new RunOrfsStageTool(stubManager, registry).execute(
        "gcd", "cts", null, null, "base", 8,
      ),
    );

    expect(result.stages).toHaveLength(1);
    expect(result.stages[0].stage).toBe("4_1_cts");
  });

  it("lists every run when no job_id is given", async () => {
    const registry = new FlowJobRegistry(stub("quick.sh", "echo ok"));
    await new RunOrfsStageTool(stubManager, registry).execute("gcd", "cts", null, null, "base", 8);

    const result = JSON.parse(await new GetOrfsJobTool(stubManager, registry).execute());

    expect(result.total_count).toBe(1);
    expect(result.jobs[0].stage).toBe("cts");
  });

  it("returns live progress for one run", async () => {
    const registry = new FlowJobRegistry(stub("quick.sh", "echo ok"));
    const started = JSON.parse(
      await new RunOrfsStageTool(stubManager, registry).execute("gcd", "route", null, null, "base", 8),
    );
    fs.appendFileSync(
      started.log_path,
      "[INFO DRT-0195] Start 1st optimization iteration.\n    Completing 80% with 19604 violations.\n",
    );

    const result = JSON.parse(
      await new GetOrfsJobTool(stubManager, registry).execute(started.job_id),
    );

    expect(result.progress.iteration).toBe(1);
    expect(result.progress.violations).toBe(19604);
    expect(result.recent_lines.length).toBeGreaterThan(0);
  });

  it("reports an unknown job rather than throwing", async () => {
    const registry = new FlowJobRegistry(stub("quick.sh", "echo ok"));

    const result = JSON.parse(await new GetOrfsJobTool(stubManager, registry).execute("nope"));

    expect(result.error).toBe("FlowJobNotFound");
  });

  it("cancels a running job", async () => {
    const registry = new FlowJobRegistry(stub("slow.sh", "sleep 300"));
    const started = JSON.parse(
      await new RunOrfsStageTool(stubManager, registry).execute("gcd", "route"),
    );

    const result = JSON.parse(
      await new CancelOrfsJobTool(stubManager, registry).execute(started.job_id),
    );

    expect(result.cancelled).toBe(true);
    expect(result.status).toBe("cancelled");
  });

  it("reports an unknown job on cancel", async () => {
    const registry = new FlowJobRegistry(stub("quick.sh", "echo ok"));

    const result = JSON.parse(await new CancelOrfsJobTool(stubManager, registry).execute("nope"));

    expect(result.error).toBe("FlowJobNotFound");
  });
});
