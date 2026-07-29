#!/usr/bin/env tsx
/**
 * Generate golden wire-format JSON files from TypeScript models and the live
 * MCP tool registration.
 *
 * These fixtures are the serialization contract for the TypeScript
 * implementation and live at typescript/__tests__/golden/fixtures/. Run via:
 *
 *   make golden   (or: cd typescript && npm run generate:golden)
 *
 * Regenerate and commit fixtures/*.json whenever a result model or tool
 * registration changes.
 *
 * The sentinel values and fixture construction mirror schema_parity.test.ts and
 * tool_manifest.test.ts exactly so the generator and the tests always agree.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

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
import { createMcpServer } from "../../src/server.js";
import type { OpenROADManager } from "../../src/core/manager.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

// Fixed sentinels — must stay identical to schema_parity.test.ts
const TS = "2026-01-01T00:00:00";
const SID = "sess-0001";

// ---------------------------------------------------------------------------
// Fixture helpers (mirrors schema_parity.test.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tool manifest (mirrors tool_manifest.test.ts)
// ---------------------------------------------------------------------------

type JsonSchema = {
  properties?: Record<string, { type?: string; anyOf?: { type?: string }[] }>;
  required?: string[];
};

function canonicalType(prop: { type?: string; anyOf?: { type?: string }[] }): string | undefined {
  if (prop.type) return prop.type;
  if (prop.anyOf) return prop.anyOf.find((b) => b.type !== "null")?.type;
  return undefined;
}

function canonicalTool(
  inputSchema: JsonSchema | undefined,
  annotations: Record<string, unknown> | undefined,
): unknown {
  const props = inputSchema?.properties ?? {};
  const required = new Set(inputSchema?.required ?? []);
  const params: Record<string, { type: string | undefined; required: boolean }> = {};
  for (const [name, prop] of Object.entries(props)) {
    params[name] = { type: canonicalType(prop), required: required.has(name) };
  }
  const a = annotations ?? {};
  return {
    params,
    annotations: {
      readOnlyHint: a.readOnlyHint ?? null,
      destructiveHint: a.destructiveHint ?? null,
      idempotentHint: a.idempotentHint ?? null,
      openWorldHint: a.openWorldHint ?? null,
    },
  };
}

async function buildToolManifest(): Promise<Record<string, unknown>> {
  // node-pty must never spawn during a list-tools check.
  const mockManager = { listSessions: () => Promise.resolve([]) } as unknown as OpenROADManager;
  const server = createMcpServer(mockManager);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "generator", version: "0.0.0" });
  await client.connect(ct);

  const { tools } = await client.listTools();
  const manifest: Record<string, unknown> = {};
  for (const t of tools) {
    manifest[t.name] = canonicalTool(
      t.inputSchema as JsonSchema | undefined,
      t.annotations as Record<string, unknown> | undefined,
    );
  }
  await client.close();

  // Sort keys alphabetically to match Python output
  return Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(FIXTURES_DIR, { recursive: true });

  for (const [name, build] of Object.entries(cases)) {
    const wire = build();
    const dest = path.join(FIXTURES_DIR, `${name}.json`);
    writeFileSync(dest, JSON.stringify(wire, null, 2) + "\n");
    console.log(`wrote fixtures/${name}.json`);
  }

  const manifest = await buildToolManifest();
  const manifestDest = path.join(FIXTURES_DIR, "tool_manifest.json");
  writeFileSync(manifestDest, JSON.stringify(manifest, null, 2) + "\n");
  console.log("wrote fixtures/tool_manifest.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
