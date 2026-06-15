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
  bufferSize: number;
  error?: string | null;
}

// Opaque snake_case payloads
// These are passed straight through to the wire (no camel->snake conversion),
// matching Python's dict output byte-for-byte.

/** One entry in a session's command history. */
export interface CommandHistoryEntry {
  command: string;
  timestamp: string;
  command_number: number;
  execution_start: number;
  execution_time?: number;
  output_length?: number;
}

/** Detailed per-session metrics returned by InteractiveSession.getDetailedMetrics. */
export interface SessionDetailedMetrics {
  session_id: string;
  state: string;
  is_alive: boolean;
  created_at: string;
  last_activity: string;
  uptime_seconds: number;
  idle_seconds: number;
  commands: {
    total_executed: number;
    current_count: number;
    history_length: number;
  };
  performance: {
    total_cpu_time: number;
    peak_memory_mb: number;
    current_memory_mb: number;
  };
  buffer: {
    current_size: number;
    max_size: number;
    utilization_percent: number;
  };
  timeout: {
    configured_seconds: number | null;
    is_timed_out: boolean;
  };
}

/** Aggregate metrics across all sessions returned by OpenROADManager.sessionMetrics. */
export interface ManagerMetrics {
  manager: {
    total_sessions: number;
    active_sessions: number;
    terminated_sessions: number;
    max_sessions: number;
    utilization_percent: number;
  };
  aggregate: {
    total_commands: number;
    total_cpu_time: number;
    total_memory_mb: number;
    avg_memory_per_session: number;
  };
  sessions: SessionDetailedMetrics[];
}

// Zod result schemas
// BaseResult pattern: every result carries `error: string | null`, defaulting to
// null. Python Pydantic always emits the `error` key (`= None` -> `null`), so we
// use `.nullable().default(null)`, never `.optional()`, to preserve key presence.

const errorField = z.string().nullable().default(null);

export const CommandRecord = z.object({
  command: z.string(),
  timestamp: z.string(),
  id: z.number(),
});
export type CommandRecord = z.infer<typeof CommandRecord>;

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
