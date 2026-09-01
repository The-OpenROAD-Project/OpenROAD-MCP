import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getSettings } from "../config/settings.js";
import { FLOW_RUN_DEFAULTS } from "../constants.js";
import {
  DEFAULT_RECENT_LINES,
  detectCurrentStage,
  parseRunProgress,
  readLogTail,
  readLogTailText,
} from "../flow/run_progress.js";
import type { RunProgress } from "../flow/run_progress.js";
import { getLogger } from "../utils/logging.js";

const logger = getLogger("flow.jobs");

export type FlowJobStatus = "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export interface FlowJobSpec {
  platform: string;
  design: string;
  variant: string;
  target: string;
  overrides: Record<string, string>;
  jobs?: number | undefined;
  dryRun?: boolean | undefined;
  timeoutSeconds?: number | undefined;
}

export interface FlowJob {
  jobId: string;
  spec: FlowJobSpec;
  argv: string[];
  status: FlowJobStatus;
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  finishedAt: string | null;
  logPath: string;
  statusPath: string;
  logsDir: string;
  /**
   * mtimeMs of every `*.json` metrics file already in logsDir when the run
   * started, keyed by stem. Lets collectResults() tell "this run wrote it"
   * from "left over from a previous run" by comparing filesystem timestamps
   * to each other, never to a wall-clock reading taken in this process --
   * that comparison raced on ephemeral runners where a clock correction or
   * coarser mtime resolution could put the write a few ms "before" startedAt.
   */
  preRunMetricsMtimes: Record<string, number>;
  pid: number | null;
  /** False once the run log could not be written; progress goes blind, the run does not. */
  logWritable: boolean;
  error: string | null;
}

/** Build the make argv. Assignments go on the command line, where they beat both the environment and the Makefile. */
export function buildMakeArgv(spec: FlowJobSpec): string[] {
  const argv: string[] = [];
  if (spec.dryRun === true) argv.push("-n");
  if (spec.jobs !== undefined && spec.jobs > 0) argv.push(`-j${spec.jobs}`);
  argv.push(spec.target);
  argv.push(`DESIGN_CONFIG=./designs/${spec.platform}/${spec.design}/config.mk`);
  argv.push(`FLOW_VARIANT=${spec.variant}`);
  for (const [key, value] of Object.entries(spec.overrides)) {
    argv.push(`${key}=${value}`);
  }
  return argv;
}

/** mtimeMs of every `*.json` file in logsDir, keyed by stem. Missing dir reads as empty. */
function snapshotMetricsMtimes(logsDir: string): Record<string, number> {
  const mtimes: Record<string, number> = {};
  let entries: string[];
  try {
    entries = fs.readdirSync(logsDir).filter((e) => e.endsWith(".json"));
  } catch {
    return mtimes;
  }
  for (const entry of entries) {
    try {
      mtimes[entry.slice(0, -".json".length)] = fs.statSync(path.join(logsDir, entry)).mtimeMs;
    } catch {
      // Removed between readdir and stat -- treat as absent from the baseline.
    }
  }
  return mtimes;
}

export class FlowJobLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowJobLimitError";
  }
}

export class FlowJobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`Flow job '${jobId}' not found`);
    this.name = "FlowJobNotFoundError";
  }
}

/**
 * Tracks `make` runs of ORFS stages.
 *
 * Output is streamed straight to a file, never through the session's 128 KB
 * circular buffer: a route log runs to tens of MB, so the buffer would discard
 * everything but the tail.
 */
export class FlowJobRegistry {
  private readonly jobs = new Map<string, FlowJob>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly waiters = new Map<string, Array<() => void>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly makeBinary = "make") {}

  get size(): number {
    return this.jobs.size;
  }

  activeCount(): number {
    let n = 0;
    for (const job of this.jobs.values()) if (job.status === "running") n += 1;
    return n;
  }

  start(spec: FlowJobSpec, cwd: string): FlowJob {
    const settings = getSettings();
    const maxJobs = settings.MAX_FLOW_JOBS ?? FLOW_RUN_DEFAULTS.MAX_JOBS;
    if (this.activeCount() >= maxJobs) {
      throw new FlowJobLimitError(
        `${this.activeCount()} flow run(s) already in progress (limit ${maxJobs}). ` +
          `Wait for one to finish or cancel it, or raise OPENROAD_MAX_FLOW_JOBS.`,
      );
    }

    const jobId = randomUUID().slice(0, 8);
    const logDir = settings.RUN_LOG_DIR;
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `${jobId}.log`);
    const statusPath = path.join(logDir, `${jobId}.status`);
    const argv = buildMakeArgv(spec);
    const logsDir = path.join(cwd, "logs", spec.platform, spec.design, spec.variant);

    const job: FlowJob = {
      jobId,
      spec,
      argv: [this.makeBinary, ...argv],
      status: "running",
      exitCode: null,
      signal: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      logPath,
      statusPath,
      logsDir,
      preRunMetricsMtimes: snapshotMetricsMtimes(logsDir),
      pid: null,
      logWritable: true,
      error: null,
    };
    this.jobs.set(jobId, job);

    const stream = fs.createWriteStream(logPath, { flags: "a" });
    // createWriteStream opens asynchronously, so a log path that is unwritable
    // -- removed, out of space, permissions -- surfaces here rather than
    // above. A stream error with no listener is an uncaught exception that
    // takes the server down, so record it on the job and let the run continue:
    // losing the log is not a reason to lose the run.
    let streamFailed = false;
    stream.on("error", (err: Error) => {
      streamFailed = true;
      job.logWritable = false;
      if (job.error === null) job.error = `Run log unavailable: ${err.message}`;
      logger.warn(`Flow job ${jobId}: run log ${logPath} could not be written: ${err.message}`);
    });
    stream.write(`$ ${this.makeBinary} ${argv.join(" ")}\n`);

    let child: ChildProcess;
    try {
      child = spawn(this.makeBinary, argv, {
        cwd,
        // No shell: overrides reach make as argv entries, never as something a
        // shell could reinterpret. Detached so the run gets its own process
        // group -- killing only `make` would strand the grandchild openroad,
        // exactly the orphan case scenario 10 found on this host.
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      stream.end();
      this._finish(job, "failed", null, null, (e as Error).message);
      return job;
    }

    job.pid = child.pid ?? null;
    this.children.set(jobId, child);
    child.stdout?.pipe(stream, { end: false });
    child.stderr?.pipe(stream, { end: false });

    child.on("error", (err) => {
      stream.end();
      this._finish(job, "failed", null, null, err.message);
    });

    child.on("close", (code, signal) => {
      const status: FlowJobStatus =
        job.status === "cancelled" || job.status === "timed_out"
          ? job.status
          : code === 0
            ? "succeeded"
            : "failed";

      // Finish only once the log has actually flushed. The child closing says
      // nothing about the pipe into the file being drained, so reporting the
      // job done here lets a caller poll immediately and read a partial log --
      // a truncated result that looks complete.
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        this._finish(job, status, code, signal, null);
      };

      if (streamFailed || stream.destroyed) {
        done();
        return;
      }
      // An errored stream never emits `finish`, so listen for both.
      stream.once("error", done);
      stream.end(done);
    });

    const timeoutSeconds = spec.timeoutSeconds ?? settings.FLOW_RUN_TIMEOUT;
    if (timeoutSeconds > 0) {
      const timer = setTimeout(() => {
        if (job.status !== "running") return;
        job.status = "timed_out";
        job.error = `Flow run exceeded ${timeoutSeconds}s and was terminated`;
        this._killTree(jobId);
      }, timeoutSeconds * 1000);
      // A pending run must not hold the process open on shutdown.
      timer.unref?.();
      this.timers.set(jobId, timer);
    }

    logger.info(`Started flow job ${jobId}: make ${argv.join(" ")}`);
    return job;
  }

  get(jobId: string): FlowJob {
    const job = this.jobs.get(jobId);
    if (job === undefined) throw new FlowJobNotFoundError(jobId);
    return job;
  }

  list(): FlowJob[] {
    return [...this.jobs.values()];
  }

  /** Signal the whole process group, escalating to SIGKILL after a grace period. */
  cancel(jobId: string): FlowJob {
    const job = this.get(jobId);
    if (job.status !== "running") return job;
    job.status = "cancelled";
    job.error = "Cancelled by request";
    this._killTree(jobId);
    return job;
  }

  /** Resolve once the job leaves `running`, or after `timeoutMs`. */
  async waitFor(jobId: string, timeoutMs: number): Promise<FlowJob> {
    const job = this.get(jobId);
    if (job.status !== "running" || timeoutMs <= 0) return job;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      const list = this.waiters.get(jobId) ?? [];
      list.push(done);
      this.waiters.set(jobId, list);
    });

    return this.get(jobId);
  }

  /** Live progress plus the tail of the run log. */
  inspect(jobId: string, recentLines = DEFAULT_RECENT_LINES): {
    job: FlowJob;
    progress: RunProgress;
    recentLines: string[];
    logBytes: number;
    logTruncated: boolean;
    elapsedSeconds: number;
  } {
    const job = this.get(jobId);
    const tail = readLogTail(job.logPath, recentLines);
    const stage = detectCurrentStage(job.logsDir);
    const end = job.finishedAt === null ? Date.now() : Date.parse(job.finishedAt);

    return {
      job,
      progress: parseRunProgress(readLogTailText(job.logPath), stage),
      recentLines: tail.lines,
      logBytes: tail.totalBytes,
      logTruncated: tail.truncated,
      elapsedSeconds: Math.max(0, (end - Date.parse(job.startedAt)) / 1000),
    };
  }

  /** Terminate every running job. Used on server shutdown. */
  async shutdown(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.status === "running") {
        job.status = "cancelled";
        job.error = "Server shutting down";
        this._killTree(job.jobId);
      }
    }
  }

  private _killTree(jobId: string): void {
    const child = this.children.get(jobId);
    const job = this.jobs.get(jobId);
    if (child === undefined || job?.pid == null) return;

    // Negative pid targets the process group, so make's children -- the
    // openroad processes actually doing the work -- go down with it.
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        process.kill(-job.pid!, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };

    signalGroup("SIGTERM");
    const killTimer = setTimeout(() => {
      if (this.children.has(jobId)) signalGroup("SIGKILL");
    }, FLOW_RUN_DEFAULTS.KILL_GRACE_MS);
    killTimer.unref?.();
  }

  private _finish(
    job: FlowJob,
    status: FlowJobStatus,
    code: number | null,
    signal: NodeJS.Signals | string | null,
    error: string | null,
  ): void {
    if (job.finishedAt !== null) return;
    job.status = status;
    job.exitCode = code;
    job.signal = signal === null ? null : String(signal);
    job.finishedAt = new Date().toISOString();
    if (error !== null) job.error = error;

    const timer = this.timers.get(job.jobId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(job.jobId);
    }
    this.children.delete(job.jobId);

    // Mirrors the .orfs-eval-logs/*.status convention already in the repo.
    try {
      fs.writeFileSync(job.statusPath, `RC=${code ?? ""}\nSTATUS=${status}\n`);
    } catch {
      /* best effort */
    }

    for (const resolve of this.waiters.get(job.jobId) ?? []) resolve();
    this.waiters.delete(job.jobId);
    logger.info(`Flow job ${job.jobId} ${status} (exit ${String(code)})`);
  }
}

export const flowJobs = new FlowJobRegistry();
