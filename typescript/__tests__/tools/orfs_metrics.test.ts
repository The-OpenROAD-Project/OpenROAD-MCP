import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mock getSettings so tests do not depend on a filesystem ORFS install.
vi.mock("../../src/config/settings.js", () => {
  let mockFlowPath = "/mock/flow";
  let mockPlatforms: string[] = [];
  let mockDesigns: Record<string, string[]> = {};
  return {
    getSettings: vi.fn(() => ({
      get flowPath() { return mockFlowPath; },
      get platforms() { return mockPlatforms; },
      designs(platform: string) { return mockDesigns[platform] ?? []; },
    })),
    __setMock: (fp: string, p: string[], d: Record<string, string[]>) => {
      mockFlowPath = fp; mockPlatforms = p; mockDesigns = d;
    },
  };
});

import { getSettings } from "../../src/config/settings.js";
import {
  ReadOrfsMetricsTool,
  parseMetricsPreservingDuplicates,
  resolvePlatform,
  resolveStages,
  evaluateGates,
  compareGate,
} from "../../src/tools/orfs_metrics.js";
import type { OpenROADManager } from "../../src/core/manager.js";

const stubManager = {} as unknown as OpenROADManager;
let tmpDir: string;

/** The stage stems a real nangate45/gcd/base run produces. */
const REAL_STEMS = [
  "1_synth", "2_1_floorplan", "2_2_floorplan_macro", "2_3_floorplan_tapcell",
  "2_4_floorplan_pdn", "3_1_place_gp_skip_io", "3_2_place_iop", "3_3_place_gp",
  "3_4_place_resized", "3_5_place_dp", "4_1_cts", "5_1_grt", "5_2_route",
  "5_3_fillcell", "6_1_fill", "6_report",
];

function mockSettings(flowPath: string, designs: Record<string, string[]>): void {
  (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
    flowPath,
    platforms: Object.keys(designs),
    designs: (p: string) => designs[p] ?? [],
  });
}

/** Builds a flow tree with logs/, designs/ and the given stage files. */
function createFlow(opts: {
  platform?: string;
  design?: string;
  variant?: string;
  stems?: string[];
  metrics?: Record<string, string>;
  logs?: Record<string, string>;
} = {}) {
  const platform = opts.platform ?? "nangate45";
  const design = opts.design ?? "gcd";
  const variant = opts.variant ?? "base";
  const flowPath = tmpDir;
  const logsDir = path.join(flowPath, "logs", platform, design, variant);
  const designDir = path.join(flowPath, "designs", platform, design);
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(designDir, { recursive: true });
  fs.mkdirSync(path.join(flowPath, "platforms", platform), { recursive: true });

  for (const stem of opts.stems ?? REAL_STEMS) {
    fs.writeFileSync(path.join(logsDir, `${stem}.json`), opts.metrics?.[stem] ?? "{}");
    fs.writeFileSync(path.join(logsDir, `${stem}.log`), opts.logs?.[stem] ?? "");
  }
  for (const [stem, body] of Object.entries(opts.logs ?? {})) {
    fs.writeFileSync(path.join(logsDir, `${stem}.log`), body);
  }
  mockSettings(flowPath, { [platform]: [design] });
  return { flowPath, logsDir, designDir };
}

async function read(tool: ReadOrfsMetricsTool, ...args: Parameters<ReadOrfsMetricsTool["execute"]>) {
  return JSON.parse(await tool.execute(...args));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orfs-metrics-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("parseMetricsPreservingDuplicates", () => {
  // Verbatim shape of the real flow/logs/nangate45/gcd/base/4_1_cts.json,
  // which records a block of metrics per sub-run.
  const REAL_CTS = `{
\t"cts__utilization__before__dpl": 76.7787,
\t"cts__design__instance__displacement__max": 6.36,
\t"cts__route__wirelength__estimated": 3732.03,
\t"cts__utilization__before__dpl": 82.1146,
\t"cts__design__instance__displacement__max": 11.77,
\t"cts__route__wirelength__estimated": 4167.95,
\t"cts__design__violations": 0,
\t"cts__timing__setup__ws": -0.113089,
\t"cts__timing__fmax__clock:core_clock": 2.43841e+09
}`;

  it("returns every value of a repeated key, in file order", () => {
    // JSON.parse keeps only 82.1146 and says nothing about the first pass.
    expect(JSON.parse(REAL_CTS)["cts__utilization__before__dpl"]).toBe(82.1146);

    const { metrics } = parseMetricsPreservingDuplicates(REAL_CTS);
    expect(metrics["cts__utilization__before__dpl"]).toEqual([76.7787, 82.1146]);
    expect(metrics["cts__design__instance__displacement__max"]).toEqual([6.36, 11.77]);
  });

  it("names the repeated keys so a caller need not type-sniff every value", () => {
    const { repeatedMetrics } = parseMetricsPreservingDuplicates(REAL_CTS);
    expect(repeatedMetrics.sort()).toEqual([
      "cts__design__instance__displacement__max",
      "cts__route__wirelength__estimated",
      "cts__utilization__before__dpl",
    ]);
  });

  it("leaves a key that appears once as a scalar", () => {
    const { metrics } = parseMetricsPreservingDuplicates(REAL_CTS);
    expect(metrics["cts__design__violations"]).toBe(0);
    expect(metrics["cts__timing__setup__ws"]).toBe(-0.113089);
    expect(metrics["cts__timing__fmax__clock:core_clock"]).toBe(2.43841e9);
  });

  it("is depth-aware, so braces and quotes inside values cannot desynchronise it", () => {
    const tricky = `{
      "nested": {"a": [1, 2, {"b": "}"}], "c": "x\\"y,z"},
      "after": 42,
      "arr": [1, {"k": "]"}],
      "nul": null,
      "yes": true,
      "text": "has, comma and : colon"
    }`;
    const { metrics } = parseMetricsPreservingDuplicates(tricky);
    expect(metrics["nested"]).toEqual({ a: [1, 2, { b: "}" }], c: 'x"y,z' });
    expect(metrics["after"]).toBe(42);
    expect(metrics["arr"]).toEqual([1, { k: "]" }]);
    expect(metrics["nul"]).toBeNull();
    expect(metrics["yes"]).toBe(true);
    expect(metrics["text"]).toBe("has, comma and : colon");
  });

  it("rejects a malformed or non-object file with a clean error", () => {
    expect(() => parseMetricsPreservingDuplicates("{ broken")).toThrow();
    expect(() => parseMetricsPreservingDuplicates("[1,2]")).toThrow(/top level/);
  });
});

describe("resolveStages", () => {
  it("matches an exact file stem", () => {
    expect(resolveStages(REAL_STEMS, "4_1_cts")).toEqual(["4_1_cts"]);
  });

  it("maps everyday stage names onto their numeric group", () => {
    expect(resolveStages(REAL_STEMS, "cts")).toEqual(["4_1_cts"]);
    expect(resolveStages(REAL_STEMS, "place")).toEqual([
      "3_1_place_gp_skip_io", "3_2_place_iop", "3_3_place_gp",
      "3_4_place_resized", "3_5_place_dp",
    ]);
    expect(resolveStages(REAL_STEMS, "floorplan")).toHaveLength(4);
    expect(resolveStages(REAL_STEMS, "synth")).toEqual(["1_synth"]);
  });

  it("maps an ORFS metric namespace onto the file that holds it", () => {
    // A metric is named globalroute__*, but the file on disk is
    // 5_1_grt.json -- unguessable without this mapping.
    expect(resolveStages(REAL_STEMS, "globalroute")).toEqual(["5_1_grt"]);
    expect(resolveStages(REAL_STEMS, "detailedroute")).toEqual(["5_2_route"]);
    expect(resolveStages(REAL_STEMS, "placeopt")).toEqual(["3_4_place_resized"]);
    expect(resolveStages(REAL_STEMS, "detailedplace")).toEqual(["3_5_place_dp"]);
    expect(resolveStages(REAL_STEMS, "finish")).toEqual(["6_report"]);
  });

  it("returns everything for 'all' and for an empty stage", () => {
    expect(resolveStages(REAL_STEMS, "all")).toHaveLength(REAL_STEMS.length);
    expect(resolveStages(REAL_STEMS, "")).toHaveLength(REAL_STEMS.length);
  });

  it("returns nothing for an unknown stage", () => {
    expect(resolveStages(REAL_STEMS, "nonsense")).toEqual([]);
  });

  it("does not depend on a hardcoded stem table", () => {
    // A renumbered ORFS release must still resolve.
    const renumbered = ["01_synth", "07_cts", "09_grt"];
    expect(resolveStages(renumbered, "cts")).toEqual(["07_cts"]);
    expect(resolveStages(renumbered, "globalroute")).toEqual(["09_grt"]);
  });
});

describe("deprecated gate exports", () => {
  it("evaluateGates judges nothing, even when given rules", () => {
    expect(
      evaluateGates(
        [{ stage: "4_1_cts", metrics: { "cts__timing__setup__ws": -0.1 } }],
        { "cts__timing__setup__ws": { value: -0.05, compare: ">=" } },
      ),
    ).toEqual({ gates: [], unmatched: [] });
  });

  it("compareGate still applies each operator", () => {
    expect(compareGate(0, "<=", 0)).toBe(true);
    expect(compareGate(-0.11, ">=", -0.05)).toBe(false);
    expect(compareGate("abc", "==", "abc")).toBe(true);
    expect(compareGate("x", ">=", 1)).toBeNull();
    expect(compareGate(1, "??", 1)).toBeNull();
  });
});

describe("resolvePlatform", () => {
  it("infers the platform when the design is unique", () => {
    createFlow();
    mockSettings(tmpDir, { nangate45: ["gcd"], sky130hd: ["ibex"] });
    expect(resolvePlatform("gcd")).toBe("nangate45");
    expect(resolvePlatform("ibex")).toBe("sky130hd");
  });

  it("names the candidates when a design exists under several platforms", () => {
    mockSettings(tmpDir, { nangate45: ["gcd"], sky130hd: ["gcd"] });
    expect(() => resolvePlatform("gcd")).toThrow(/multiple platforms.*nangate45.*sky130hd/s);
  });

  it("lists what is available when the design is unknown", () => {
    mockSettings(tmpDir, { nangate45: ["gcd"] });
    expect(() => resolvePlatform("nope")).toThrow(/nangate45\/gcd/);
  });

  it("still validates an explicitly passed platform", () => {
    mockSettings(tmpDir, { nangate45: ["gcd"] });
    expect(() => resolvePlatform("gcd", "sky130hd")).toThrow(/Platform 'sky130hd' not found/);
    expect(() => resolvePlatform("ibex", "nangate45")).toThrow(/Design 'ibex' not found/);
  });
});

describe("ReadOrfsMetricsTool", () => {
  const tool = () => new ReadOrfsMetricsTool(stubManager);

  it("returns one stage's metrics, arrays intact, from a design name alone", async () => {
    createFlow({
      metrics: {
        "4_1_cts": `{"cts__utilization__before__dpl": 76.7787,
                     "cts__utilization__before__dpl": 82.1146,
                     "cts__timing__setup__ws": -0.113089}`,
      },
    });

    const result = await read(tool(), "gcd", "cts");

    expect(result.error).toBeNull();
    expect(result.platform).toBe("nangate45");
    expect(result.variant).toBe("base");
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0].stage).toBe("4_1_cts");
    expect(result.stages[0].metrics.cts__utilization__before__dpl).toEqual([76.7787, 82.1146]);
    expect(result.stages[0].repeated_metrics).toEqual(["cts__utilization__before__dpl"]);
  });

  it("keeps the deprecated gate fields in the result, empty", async () => {
    createFlow({ metrics: { "4_1_cts": `{"cts__timing__setup__ws": -0.113089}` } });

    const result = await read(tool(), "gcd", "cts");

    expect(result.gates).toEqual([]);
    expect(result.unmatched_gates).toEqual([]);
    expect(result.gate_summary).toEqual({
      total: 0, pass: 0, fail: 0, unknown: 0,
      failing_errors: 0, failing_warnings: 0, unmatched: 0,
    });
    expect(result.rules_path).toBeNull();
    expect(result.message).toBeNull();
  });

  it("keeps the deprecated gate fields in a failure result, empty", async () => {
    createFlow({ stems: ["4_1_cts"] });

    const result = await read(tool(), "gcd", "nonsense");

    expect(result.error).toBe("StageNotFound");
    expect(result.gates).toEqual([]);
    expect(result.unmatched_gates).toEqual([]);
    expect(result.gate_summary).toBeNull();
    expect(result.rules_path).toBeNull();
  });

  it("extracts ORFS's tagged diagnostics from the stage log", async () => {
    createFlow({
      logs: {
        "6_report": [
          "[INFO ORD-0030] Something routine.",
          "[ERROR ORD-2018] Pin is not ITerm or BTerm or modITerm.",
          "[WARNING STA-0123] Some warning.",
          "[ERROR GUI-0070] ORD-2018",
          "this line mentions error but is not tagged",
        ].join("\n"),
      },
    });

    const result = await read(tool(), "gcd", "finish");

    const log = result.stages[0].log;
    expect(log.errors).toEqual([
      "[ERROR ORD-2018] Pin is not ITerm or BTerm or modITerm.",
      "[ERROR GUI-0070] ORD-2018",
    ]);
    expect(log.warnings).toEqual(["[WARNING STA-0123] Some warning."]);
    expect(log.error_count).toBe(2);
    expect(log.truncated).toBe(false);
  });

  it("caps log diagnostics and says so rather than truncating silently", async () => {
    const noisy = Array.from({ length: 120 }, (_, i) => `[WARNING STA-${i}] noisy`).join("\n");
    createFlow({ logs: { "6_report": noisy } });

    const log = (await read(tool(), "gcd", "finish")).stages[0].log;

    expect(log.warnings).toHaveLength(50);
    expect(log.warning_count).toBe(120);
    expect(log.truncated).toBe(true);
  });

  it("still reports a stage that has a log but no metrics file", async () => {
    // A crashed stage often writes no JSON at all; its log is the whole story.
    const { logsDir } = createFlow({ stems: ["1_synth"] });
    fs.writeFileSync(path.join(logsDir, "1_2_yosys.log"), "[ERROR YOSYS-1] boom");

    const result = await read(tool(), "gcd", "1_2_yosys");

    expect(result.stages[0].metrics_path).toBeNull();
    expect(result.stages[0].log.errors).toEqual(["[ERROR YOSYS-1] boom"]);
  });

  it("flags a half-written metrics file instead of dropping the stage", async () => {
    createFlow({ stems: ["4_1_cts"], metrics: { "4_1_cts": '{"cts__a": 1,' } });

    const result = await read(tool(), "gcd", "cts");

    expect(result.error).toBeNull();
    expect(result.stages[0].error).toMatch(/MalformedMetrics/);
  });

  it("lists the stages that exist when the requested one does not", async () => {
    createFlow({ stems: ["4_1_cts", "6_report"] });

    const result = await read(tool(), "gcd", "nonsense");

    expect(result.error).toBe("StageNotFound");
    expect(result.message).toContain("4_1_cts");
    expect(result.message).toContain("6_report");
  });

  it("reports the available variants when the run does not exist", async () => {
    createFlow({ variant: "base", stems: ["4_1_cts"] });

    const result = await read(tool(), "gcd", "cts", null, "nosuchvariant");

    expect(result.error).toBe("RunNotFound");
    expect(result.message).toContain("base");
  });

  it("rejects path traversal in design and variant", async () => {
    createFlow({ stems: ["4_1_cts"] });

    for (const bad of ["..", "../../etc", "a/b"]) {
      expect((await read(tool(), bad, "cts")).error).toBe("ValidationError");
      expect((await read(tool(), "gcd", "cts", null, bad)).error).toBe("ValidationError");
    }
  });

  it("returns paths relative to the flow root, not absolute host paths", async () => {
    createFlow({ stems: ["4_1_cts"] });

    const result = await read(tool(), "gcd", "cts");

    expect(result.logs_path).toBe("logs/nangate45/gcd/base");
    expect(result.stages[0].metrics_path).toBe("logs/nangate45/gcd/base/4_1_cts.json");
  });
});
