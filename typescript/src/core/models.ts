import { z } from "zod";

export enum SessionState {
  CREATING = "creating",
  ACTIVE = "active",
  TERMINATED = "terminated",
  ERROR = "error",
}

export enum ProcessState {
  STOPPED = "stopped",
  STARTING = "starting",
  RUNNING = "running",
  ERROR = "error",
}

// Domain interfaces (camelCase)
// These remain plain interfaces and are converted to the snake_case MCP wire
// format at the tool serialization boundary (BaseTool.formatResult, Part 2).

export interface InteractiveSessionInfo {
  sessionId: string;
  createdAt: string;
  isAlive: boolean;
  commandCount: number;
  bufferSize: number;
  uptimeSeconds: number | null;
  state: SessionState | null;
  error?: string | null;
}

export interface InteractiveExecResult {
  output: string;
  sessionId: string | null;
  timestamp: string;
  executionTime: number;
  commandCount: number;
  /**
   * The session buffer's capacity in characters -- the ceiling that
   * `bytesDiscarded` was measured against.
   *
   * Note this differs from InteractiveSessionInfo.bufferSize, which is the
   * live residual buffer. Reporting the residual here was useless: a command
   * result is produced only after the buffer has been drained, so the field
   * was structurally always 0.
   */
  bufferSize: number;
  /** True when output exceeded the buffer and the head was thrown away. */
  truncated: boolean;
  /** Characters dropped from the START of the output. 0 when complete. */
  bytesDiscarded: number;
  /**
   * Total raw characters the command produced, before ANSI and sentinel
   * cleaning. Slightly exceeds output.length + bytesDiscarded on a truncated
   * result; the difference is escape sequences and plumbing, not lost content.
   */
  totalBytes: number;
  error?: string | null;
}

// Nested domain payloads (camelCase)
// Authored in camelCase like every other domain model and converted to the
// snake_case MCP wire format at the serialization boundary
// (BaseTool.formatResult -> toSnakeCase). Nothing here is hand-written in
// snake_case, so the wire convention is produced by a single rule.

/** One entry in a session's command history. */
export interface CommandHistoryEntry {
  command: string;
  timestamp: string;
  commandNumber: number;
  executionStart: number;
  executionTime?: number;
  outputLength?: number;
}

/** Detailed per-session metrics returned by InteractiveSession.getDetailedMetrics. */
export interface SessionDetailedMetrics {
  sessionId: string;
  state: string;
  isAlive: boolean;
  createdAt: string;
  lastActivity: string;
  uptimeSeconds: number;
  idleSeconds: number;
  commands: {
    totalExecuted: number;
    currentCount: number;
    historyLength: number;
  };
  performance: {
    totalCpuTime: number;
    peakMemoryMb: number;
    currentMemoryMb: number;
  };
  buffer: {
    currentSize: number;
    maxSize: number;
    utilizationPercent: number;
  };
  timeout: {
    configuredSeconds: number | null;
    isTimedOut: boolean;
  };
}

/** Aggregate metrics across all sessions returned by OpenROADManager.sessionMetrics. */
export interface ManagerMetrics {
  manager: {
    totalSessions: number;
    activeSessions: number;
    terminatedSessions: number;
    maxSessions: number;
    utilizationPercent: number;
  };
  aggregate: {
    totalCommands: number;
    totalCpuTime: number;
    totalMemoryMb: number;
    avgMemoryPerSession: number;
  };
  sessions: SessionDetailedMetrics[];
}

// Zod result schemas
// Mirrors Python's Pydantic models in core/models.py. Every result carries
// `error: string | null` (defaulting to null) matching Pydantic's `= None`
// serialization. These are wired up at the tool serialization boundary
// (BaseTool.formatResult, Part 2).

const errorField = z.string().nullable().default(null);

export const InteractiveSessionListResult = z.object({
  sessions: z.array(z.custom<InteractiveSessionInfo>()).default([]),
  totalCount: z.number().default(0),
  activeCount: z.number().default(0),
  error: errorField,
});
export type InteractiveSessionListResult = z.infer<typeof InteractiveSessionListResult>;

export const SessionTerminationResult = z.object({
  sessionId: z.string(),
  terminated: z.boolean(),
  wasAlive: z.boolean().default(false),
  force: z.boolean().default(false),
  error: errorField,
});
export type SessionTerminationResult = z.infer<typeof SessionTerminationResult>;

export const SessionInspectionResult = z.object({
  sessionId: z.string(),
  metrics: z.custom<SessionDetailedMetrics>().nullable().default(null),
  error: errorField,
});
export type SessionInspectionResult = z.infer<typeof SessionInspectionResult>;

export const SessionHistoryResult = z.object({
  sessionId: z.string(),
  history: z.array(z.custom<CommandHistoryEntry>()).default([]),
  totalCommands: z.number().default(0),
  limit: z.number().nullable().default(null),
  search: z.string().nullable().default(null),
  error: errorField,
});
export type SessionHistoryResult = z.infer<typeof SessionHistoryResult>;

export const SessionMetricsResult = z.object({
  metrics: z.custom<ManagerMetrics>().nullable().default(null),
  error: errorField,
});
export type SessionMetricsResult = z.infer<typeof SessionMetricsResult>;

// Session output search models

/** One retained command output, searchable after the command has returned. */
export interface SessionOutputRecord {
  commandNumber: number;
  command: string;
  timestamp: string;
  output: string;
  /** True when the result was larger than the retention budget and lost its head. */
  truncated: boolean;
}

export interface SessionGrepMatch {
  commandNumber: number;
  command: string;
  /** 1-based line number within that command's output. */
  lineNumber: number;
  line: string;
  before?: string[];
  after?: string[];
}

export interface SessionGrepResult {
  matches: SessionGrepMatch[];
  /** Matches found, which exceeds matches.length when capped. */
  totalMatches: number;
  truncated: boolean;
  /**
   * How the pattern was applied: as a regex, as a literal because it did not
   * compile, or as a literal after the regex matched nothing (a pasted net
   * name like `dpath.a_reg[0]` is valid regex that matches nothing).
   */
  patternKind: "regex" | "substring" | "substring-fallback";
  searchedCommands: number;
  searchedLines: number;
  retainedChars: number;
  /** Commands whose output was evicted to stay inside the retention budget. */
  evictedCommands: number;
}

export const SessionGrepOutputResult = z.object({
  sessionId: z.string().nullable().default(null),
  pattern: z.string().nullable().default(null),
  matches: z.array(z.custom<SessionGrepMatch>()).default([]),
  totalMatches: z.number().default(0),
  truncated: z.boolean().default(false),
  patternKind: z.string().nullable().default(null),
  searchedCommands: z.number().default(0),
  searchedLines: z.number().default(0),
  retainedChars: z.number().default(0),
  evictedCommands: z.number().default(0),
  message: z.string().nullable().default(null),
  error: errorField,
});
export type SessionGrepOutputResult = z.infer<typeof SessionGrepOutputResult>;

// ORFS metrics models

/** One stage's metrics file, as read from logs/<platform>/<design>/<variant>. */
export interface OrfsStageMetrics {
  stage: string;
  metricsPath: string | null;
  metrics: Record<string, unknown>;
  /**
   * Metric keys the file recorded more than once, whose values are therefore
   * arrays. ORFS appends a block per sub-run, so this is normal rather than
   * corruption -- but a caller must know which keys are arrays.
   */
  repeatedMetrics: string[];
  log: {
    path: string;
    errors: string[];
    warnings: string[];
    errorCount: number;
    warningCount: number;
    truncated: boolean;
  } | null;
  error?: string | null;
}

export const OrfsMetricsResult = z.object({
  platform: z.string().nullable().default(null),
  design: z.string().nullable().default(null),
  variant: z.string().nullable().default(null),
  stage: z.string().nullable().default(null),
  logsPath: z.string().nullable().default(null),
  stages: z.array(z.custom<OrfsStageMetrics>()).default([]),
  availableStages: z.array(z.string()).default([]),
  /**
   * @deprecated Always empty. ORFS removed its per-design rules files. Run the
   * ORFS `metadata` target to check QoR.
   */
  gates: z.array(z.custom<unknown>()).default([]),
  /** @deprecated Always empty. See `gates`. */
  unmatchedGates: z.array(z.custom<unknown>()).default([]),
  /** @deprecated All counts are zero on success, and `null` on failure. See `gates`. */
  gateSummary: z.custom<unknown>().nullable().default(null),
  /** @deprecated Always `null`. See `gates`. */
  rulesPath: z.string().nullable().default(null),
  message: z.string().nullable().default(null),
  error: errorField,
});
export type OrfsMetricsResult = z.infer<typeof OrfsMetricsResult>;

// Image models

export const ImageInfo = z.object({
  filename: z.string(),
  path: z.string(),
  sizeBytes: z.number(),
  modifiedTime: z.string(),
  type: z.string(),
});
export type ImageInfo = z.infer<typeof ImageInfo>;

export const ImageMetadata = z.object({
  filename: z.string(),
  format: z.string(),
  sizeBytes: z.number(),
  width: z.number().nullable().default(null),
  height: z.number().nullable().default(null),
  modifiedTime: z.string(),
  stage: z.string(),
  type: z.string(),
  compressionApplied: z.boolean().default(false),
  originalSizeBytes: z.number().nullable().default(null),
  originalWidth: z.number().nullable().default(null),
  originalHeight: z.number().nullable().default(null),
  compressionRatio: z.number().nullable().default(null),
});
export type ImageMetadata = z.infer<typeof ImageMetadata>;

export const ListImagesResult = z.object({
  runPath: z.string().nullable().default(null),
  totalImages: z.number().nullable().default(null),
  imagesByStage: z.record(z.string(), z.array(ImageInfo)).nullable().default(null),
  message: z.string().nullable().default(null),
  error: errorField,
});
export type ListImagesResult = z.infer<typeof ListImagesResult>;

export const ReadImageResult = z.object({
  imageData: z.string().nullable().default(null),
  metadata: ImageMetadata.nullable().default(null),
  message: z.string().nullable().default(null),
  error: errorField,
});
export type ReadImageResult = z.infer<typeof ReadImageResult>;
