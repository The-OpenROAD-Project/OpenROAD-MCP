import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

import { goldenDir } from "./golden_dir.js";
import { toSnakeCase } from "../../src/tools/base.js";
import {
  InteractiveSessionListResult,
  SessionTerminationResult,
  SessionInspectionResult,
  SessionHistoryResult,
  SessionMetricsResult,
  ListImagesResult,
  ReadImageResult,
  type InteractiveExecResult,
  type InteractiveSessionInfo,
  type SessionDetailedMetrics,
  type ManagerMetrics,
  type CommandHistoryEntry,
  type ImageInfo,
  type ImageMetadata,
  SessionState,
} from "../../src/core/models.js";

// Cross-implementation schema-parity check.
//
// The Python golden files (python/tests/golden/*.json, produced by
// generate_golden.py) are the wire-format contract. Here we build the
// equivalent objects through the SAME TypeScript types and serialize them the
// SAME way production does (BaseTool.formatResult -> toSnakeCase, plus
// zod.parse for the schema-backed results), then assert the result matches the
// golden.
//
// Comparison is structural (parse both sides, deep-equal) rather than
// byte-for-byte: Python and TypeScript legitimately differ on JSON key order
// (Pydantic emits the BaseResult `error` field first) and float formatting
// (0.0 vs 0), neither of which is part of the contract. What IS part of the
// contract — field names after snake_case conversion, null-vs-missing keys,
// enums-as-strings, defaults, and nesting — is exactly what deep-equal checks.

const GOLDEN_DIR = goldenDir();

function golden(name: string): unknown {
  return JSON.parse(readFileSync(path.join(GOLDEN_DIR, `${name}.json`), "utf8"));
}

// Fixed sentinels — must stay identical to generate_golden.py.
const TS = "2026-01-01T00:00:00";
const SID = "sess-0001";

const detailedMetrics = (sessionId = SID): SessionDetailedMetrics => ({
  sessionId,
  state: "active",
  isAlive: true,
  createdAt: TS,
  lastActivity: TS,
  uptimeSeconds: 12.5,
  idleSeconds: 3.25,
  commands: { totalExecuted: 4, currentCount: 4, historyLength: 4 },
  performance: { totalCpuTime: 1.5, peakMemoryMb: 128.0, currentMemoryMb: 96.0 },
  buffer: { currentSize: 2048, maxSize: 131072, utilizationPercent: 1.5625 },
  timeout: { configuredSeconds: 300.0, isTimedOut: false },
});

const managerMetrics = (): ManagerMetrics => ({
  manager: {
    totalSessions: 2,
    activeSessions: 1,
    terminatedSessions: 1,
    maxSessions: 10,
    utilizationPercent: 10.0,
  },
  aggregate: {
    totalCommands: 4,
    totalCpuTime: 1.5,
    totalMemoryMb: 96.0,
    avgMemoryPerSession: 96.0,
  },
  sessions: [detailedMetrics()],
});

const historyEntry = (): CommandHistoryEntry => ({
  command: "place_design",
  timestamp: TS,
  commandNumber: 1,
  executionStart: 1767225600.0,
  executionTime: 0.75,
  outputLength: 42,
});

const activeInfo: InteractiveSessionInfo = {
  sessionId: SID,
  createdAt: TS,
  isAlive: true,
  commandCount: 5,
  bufferSize: 4096,
  uptimeSeconds: 12.5,
  state: SessionState.ACTIVE,
  error: null,
};

const deadInfo: InteractiveSessionInfo = {
  sessionId: "sess-0002",
  createdAt: TS,
  isAlive: false,
  commandCount: 0,
  bufferSize: 0,
  uptimeSeconds: null,
  state: null,
  error: "Session failed to start",
};

// Each entry: the production-equivalent serialization, keyed by golden name.
// `wire()` mirrors BaseTool.formatResult for plain interfaces (toSnakeCase)
// and the zod-backed tools (parse then toSnakeCase).
const cases: Record<string, () => unknown> = {
  interactive_exec_result_success: () => {
    const r: InteractiveExecResult = {
      output: "OpenROAD v2.0",
      sessionId: SID,
      timestamp: TS,
      executionTime: 1.5,
      commandCount: 3,
      bufferSize: 2048,
      error: null,
    };
    return toSnakeCase(r);
  },
  interactive_exec_result_error: () => {
    const r: InteractiveExecResult = {
      output: "",
      sessionId: SID,
      timestamp: TS,
      executionTime: 0.0,
      commandCount: 0,
      bufferSize: 0,
      error: "CommandBlocked: 'exit'",
    };
    return toSnakeCase(r);
  },
  interactive_session_info_success: () => toSnakeCase(activeInfo),
  interactive_session_info_error: () => toSnakeCase(deadInfo),
  interactive_session_list: () =>
    toSnakeCase(
      InteractiveSessionListResult.parse({
        sessions: [activeInfo, deadInfo],
        totalCount: 2,
        activeCount: 1,
      }),
    ),
  session_termination: () =>
    toSnakeCase(
      SessionTerminationResult.parse({
        sessionId: SID,
        terminated: true,
        wasAlive: true,
        force: false,
      }),
    ),
  session_inspection: () =>
    toSnakeCase(
      SessionInspectionResult.parse({
        sessionId: SID,
        metrics: detailedMetrics(),
      }),
    ),
  session_history: () =>
    toSnakeCase(
      SessionHistoryResult.parse({
        sessionId: SID,
        history: [historyEntry()],
        totalCommands: 1,
        limit: 10,
        search: "place",
      }),
    ),
  session_metrics: () =>
    toSnakeCase(SessionMetricsResult.parse({ metrics: managerMetrics() })),
  list_images: () => {
    const floorplan: ImageInfo = {
      filename: "floorplan.webp",
      path: "/reports/nangate45/gcd/base/floorplan.webp",
      sizeBytes: 15000,
      modifiedTime: TS,
      type: "floorplan",
    };
    const route: ImageInfo = {
      filename: "route.webp",
      path: "/reports/nangate45/gcd/base/route.webp",
      sizeBytes: 22000,
      modifiedTime: TS,
      type: "route",
    };
    return toSnakeCase(
      ListImagesResult.parse({
        runPath: "/reports/nangate45/gcd/base",
        totalImages: 2,
        imagesByStage: { floorplan: [floorplan], route: [route] },
      }),
    );
  },
  list_images_empty: () =>
    toSnakeCase(ListImagesResult.parse({ message: "No images found" })),
  read_image: () => {
    const metadata: ImageMetadata = {
      filename: "floorplan.webp",
      format: "webp",
      sizeBytes: 15000,
      width: 1024,
      height: 768,
      modifiedTime: TS,
      stage: "floorplan",
      type: "floorplan",
      compressionApplied: true,
      originalSizeBytes: 48000,
      originalWidth: 2048,
      originalHeight: 1536,
      compressionRatio: 0.3125,
    };
    return toSnakeCase(
      ReadImageResult.parse({ imageData: "aGVsbG8=", metadata }),
    );
  },
  read_image_error: () =>
    toSnakeCase(ReadImageResult.parse({ error: "Image not found: foo.png" })),
};

describe("schema parity with Python golden files", () => {
  for (const [name, build] of Object.entries(cases)) {
    it(`${name} matches the Python wire format`, () => {
      expect(build()).toEqual(golden(name));
    });
  }
});
