import fs from "node:fs";
import path from "node:path";
import { getSettings } from "../config/settings.js";
import type { OpenROADManager } from "../core/manager.js";
import { flowJobs, FlowJobLimitError, FlowJobNotFoundError } from "../core/flow_jobs.js";
import type { FlowJob, FlowJobRegistry } from "../core/flow_jobs.js";
import { ValidationError } from "../exceptions.js";
import { DEFAULT_RECENT_LINES } from "../flow/run_progress.js";
import { validatePathSegment } from "../utils/path_security.js";
import { BaseTool } from "./base.js";
import {
  evaluateGates,
  parseMetricsPreservingDuplicates,
  resolvePlatform,
  resolveStages,
} from "./orfs_metrics.js";
import type { GateRule } from "./orfs_metrics.js";

/**
 * Make targets this server will run.
 *
 * OPENROAD_ALLOWED_COMMANDS gates the `openroad` binary only and does not cover
 * this path, so the flow runner carries its own policy. An allowlist also stops
 * a target doubling as a make flag: `-f/tmp/evil.mk` would otherwise be handed
 * to make as an argument, not a goal.
 */
export const ALLOWED_TARGETS = new Set([
  "synth", "floorplan", "place", "cts", "grt", "route", "finish", "all", "metadata",
  "clean_synth", "clean_floorplan", "clean_place", "clean_cts", "clean_route",
  "clean_finish", "clean_metadata", "clean_all",
]);

/** Make variables that would redirect execution, whatever their value. */
const DENIED_OVERRIDE_KEYS = new Set([
  "SHELL", "MAKESHELL", ".SHELLFLAGS", "MAKE", "MAKEFLAGS", "MAKEFILES",
  "PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
]);

const OVERRIDE_KEY = /^[A-Z_][A-Z0-9_]*$/;

/** Reject a target that is not a known ORFS goal. */
export function validateTarget(stage: string): string {
  const target = stage.trim();
  if (!ALLOWED_TARGETS.has(target)) {
    throw new ValidationError(
      `Stage '${stage}' is not a runnable ORFS target. ` +
        `Allowed: ${[...ALLOWED_TARGETS].sort().join(", ")}`,
    );
  }
  return target;
}

/**
 * Reject override keys and values that could redirect what make executes.
 *
 * `shell: false` stops a shell reinterpreting a value, but make itself expands
 * `$(...)` inside variable values and will use an overridden SHELL to run every
 * recipe -- so neither is safe to accept.
 */
export function validateOverrides(
  overrides: Record<string, string> | undefined | null,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(overrides ?? {})) {
    if (!OVERRIDE_KEY.test(key)) {
      throw new ValidationError(
        `Override key '${key}' is not a valid make variable name (expected ^[A-Z_][A-Z0-9_]*$)`,
      );
    }
    if (DENIED_OVERRIDE_KEYS.has(key)) {
      throw new ValidationError(
        `Override key '${key}' is not allowed: it controls how make executes its recipes.`,
      );
    }
    const value = String(rawValue);
    if (/[\r\n\0]/.test(value)) {
      throw new ValidationError(`Override '${key}' cannot contain newlines or null bytes`);
    }
    if (value.includes("$(") || value.includes("${") || value.includes("`")) {
      throw new ValidationError(
        `Override '${key}' cannot contain '$(', '\${' or backticks: make expands these when it reads the value.`,
      );
    }
    clean[key] = value;
  }
  return clean;
}

/** Metrics and gate verdicts for a finished run, reusing the read_orfs_metrics machinery. */
function collectResults(job: FlowJob): {
  stages: Array<{ stage: string; metrics: Record<string, unknown>; repeatedMetrics: string[] }>;
  gates: unknown[];
  gateSummary: Record<string, number> | null;
} {
  const settings = getSettings();
  let stems: string[] = [];
  try {
    stems = fs
      .readdirSync(job.logsDir)
      .filter((e) => e.endsWith(".json"))
      .map((e) => e.slice(0, -".json".length))
      .sort();
  } catch {
    return { stages: [], gates: [], gateSummary: null };
  }

  // Only count metrics this run actually produced. A `make` that finds its
  // target up to date exits in milliseconds having written nothing, and the
  // stage files from a previous run are still on disk -- reporting those as
  // this job's results turns "nothing happened" into a green QoR report.
  //
  // Compared against the pre-run mtime snapshot rather than job.startedAt: a
  // wall-clock reading taken in this process and a file's mtime come from
  // independent clock reads, and comparing them raced on ephemeral runners
  // (a clock correction, or mtime resolution coarser than a millisecond)
  // could land the write a few ms "before" startedAt and drop a stage this
  // run genuinely just wrote.
  const selected = resolveStages(stems, job.spec.target);
  const stages = selected.flatMap((stem) => {
    const metricsPath = path.join(job.logsDir, `${stem}.json`);
    try {
      const mtimeMs = fs.statSync(metricsPath).mtimeMs;
      if (mtimeMs === job.preRunMetricsMtimes[stem]) return [];
      const parsed = parseMetricsPreservingDuplicates(fs.readFileSync(metricsPath, "utf8"));
      return [{ stage: stem, metrics: parsed.metrics, repeatedMetrics: parsed.repeatedMetrics }];
    } catch {
      return [];
    }
  });

  let rules: Record<string, GateRule> = {};
  try {
    rules = JSON.parse(
      fs.readFileSync(
        path.join(settings.flowPath, "designs", job.spec.platform, job.spec.design, "rules-base.json"),
        "utf8",
      ),
    ) as Record<string, GateRule>;
  } catch {
    rules = {};
  }

  const { gates } = evaluateGates(stages, rules);
  const failing = gates.filter((g) => g.status === "fail");
  return {
    stages,
    gates,
    gateSummary: {
      total: gates.length,
      pass: gates.filter((g) => g.status === "pass").length,
      fail: failing.length,
      failingErrors: failing.filter((g) => g.level === "error").length,
    },
  };
}

/** Shared serialisation for a job, with progress and (when finished) results. */
function describeJob(
  registry: FlowJobRegistry,
  jobId: string,
  recentLines: number,
): Record<string, unknown> {
  const view = registry.inspect(jobId, recentLines);
  const { job } = view;
  const finished = job.status !== "running";
  const results = finished && job.status === "succeeded" ? collectResults(job) : null;

  return {
    jobId: job.jobId,
    status: job.status,
    platform: job.spec.platform,
    design: job.spec.design,
    variant: job.spec.variant,
    stage: job.spec.target,
    overrides: job.spec.overrides,
    dryRun: job.spec.dryRun === true,
    command: job.argv.join(" "),
    pid: job.pid,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedSeconds: view.elapsedSeconds,
    exitCode: job.exitCode,
    signal: job.signal,
    logPath: job.logPath,
    logBytes: view.logBytes,
    logTruncated: view.logTruncated,
    progress: view.progress,
    recentLines: view.recentLines,
    stages: results?.stages ?? [],
    gates: results?.gates ?? [],
    gateSummary: results?.gateSummary ?? null,
    error: job.error,
  };
}

function failure(error: string, message: string): string {
  return JSON.stringify({ job_id: null, status: null, message, error });
}

/** Start an ORFS flow stage as a tracked background run. */
export class RunOrfsStageTool extends BaseTool {
  constructor(manager: OpenROADManager, private readonly registry: FlowJobRegistry = flowJobs) {
    super(manager);
  }

  async execute(
    design: string,
    stage: string,
    overrides?: Record<string, string> | null,
    platform?: string | null,
    variant = "base",
    waitSeconds?: number | null,
    jobs?: number | null,
    timeoutSeconds?: number | null,
    dryRun?: boolean | null,
    recentLines = DEFAULT_RECENT_LINES,
  ): Promise<string> {
    let resolvedPlatform: string;
    let target: string;
    let cleanOverrides: Record<string, string>;
    try {
      validatePathSegment(design, "design");
      validatePathSegment(variant, "variant");
      resolvedPlatform = resolvePlatform(design, platform);
      target = validateTarget(stage);
      cleanOverrides = validateOverrides(overrides);
    } catch (e) {
      if (e instanceof ValidationError) return failure(e.constructor.name, e.message);
      return failure("UnexpectedError", (e as Error).message ?? String(e));
    }

    const flowPath = getSettings().flowPath;
    if (!fs.existsSync(flowPath)) {
      return failure("FlowPathNotFound", `ORFS flow directory not found at ${flowPath}`);
    }

    let job: FlowJob;
    try {
      job = this.registry.start(
        {
          platform: resolvedPlatform,
          design,
          variant,
          target,
          overrides: cleanOverrides,
          ...(jobs != null && { jobs }),
          ...(dryRun != null && { dryRun }),
          ...(timeoutSeconds != null && { timeoutSeconds }),
        },
        flowPath,
      );
    } catch (e) {
      if (e instanceof FlowJobLimitError) return failure("FlowJobLimit", e.message);
      return failure("UnexpectedError", (e as Error).message ?? String(e));
    }

    if (waitSeconds != null && waitSeconds > 0) {
      await this.registry.waitFor(job.jobId, waitSeconds * 1000);
    }

    return this.formatResult(describeJob(this.registry, job.jobId, recentLines));
  }
}

/** Poll one flow run, or list them all. */
export class GetOrfsJobTool extends BaseTool {
  constructor(manager: OpenROADManager, private readonly registry: FlowJobRegistry = flowJobs) {
    super(manager);
  }

  async execute(jobId?: string | null, recentLines = DEFAULT_RECENT_LINES): Promise<string> {
    if (jobId == null || jobId === "") {
      return this.formatResult({
        jobs: this.registry.list().map((j) => ({
          jobId: j.jobId,
          status: j.status,
          design: j.spec.design,
          stage: j.spec.target,
          variant: j.spec.variant,
          startedAt: j.startedAt,
          finishedAt: j.finishedAt,
          exitCode: j.exitCode,
        })),
        totalCount: this.registry.size,
        activeCount: this.registry.activeCount(),
        error: null,
      });
    }

    try {
      return this.formatResult(describeJob(this.registry, jobId, recentLines));
    } catch (e) {
      if (e instanceof FlowJobNotFoundError) return failure("FlowJobNotFound", e.message);
      return failure("UnexpectedError", (e as Error).message ?? String(e));
    }
  }
}

/** Terminate a flow run and every process it spawned. */
export class CancelOrfsJobTool extends BaseTool {
  constructor(manager: OpenROADManager, private readonly registry: FlowJobRegistry = flowJobs) {
    super(manager);
  }

  async execute(jobId: string): Promise<string> {
    try {
      const job = this.registry.cancel(jobId);
      return this.formatResult({
        jobId: job.jobId,
        status: job.status,
        cancelled: job.status === "cancelled",
        exitCode: job.exitCode,
        error: null,
      });
    } catch (e) {
      if (e instanceof FlowJobNotFoundError) return failure("FlowJobNotFound", e.message);
      return failure("UnexpectedError", (e as Error).message ?? String(e));
    }
  }
}
