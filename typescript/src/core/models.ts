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

