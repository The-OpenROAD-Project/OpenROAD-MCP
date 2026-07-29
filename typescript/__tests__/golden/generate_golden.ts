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
 * registration changes. The fixture-building logic lives entirely in
 * fixture_helpers.ts, which is shared with schema_parity.test.ts and
 * tool_manifest.test.ts so there is no duplicated code to keep in sync.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { cases, canonicalTool, type JsonSchema } from "./fixture_helpers.js";
import { createMcpServer } from "../../src/server.js";
import type { OpenROADManager } from "../../src/core/manager.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

async function buildToolManifest(): Promise<Record<string, unknown>> {
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

  return Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
}

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
