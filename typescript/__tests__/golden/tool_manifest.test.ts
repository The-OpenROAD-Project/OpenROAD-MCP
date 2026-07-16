import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { goldenDir } from "./golden_dir.js";
import { createMcpServer } from "../../src/server.js";
import type { OpenROADManager } from "../../src/core/manager.js";

// node-pty must never spawn during a list-tools check.
vi.mock("node-pty", () => ({ spawn: vi.fn() }));

// Cross-implementation tool-contract check (doc Section 4).
//
// tests/golden/tool_manifest.json is generated from the Python FastMCP server
// (generate_golden.py) and captures, per tool, the canonical param set
// (name -> {type, required}) and the four annotation hints. Here we boot the
// TypeScript server, read its own MCP tools/list output, normalize it the same
// way, and assert an exact match. A renamed param, a flipped required flag, or
// a changed readOnly/destructive/idempotent hint fails CI.
//
// Normalization collapses the incidental schema differences between Pydantic
// and zod (Pydantic's `anyOf: [{type}, {type: null}]` for optionals vs zod's
// bare `{type}`, plus zod's min/max/$schema noise) down to the base type name.

const GOLDEN = path.join(goldenDir(), "tool_manifest.json");

type JsonSchema = {
  properties?: Record<string, { type?: string; anyOf?: { type?: string }[] }>;
  required?: string[];
};

function canonicalType(prop: { type?: string; anyOf?: { type?: string }[] }): string | undefined {
  if (prop.type) return prop.type;
  if (prop.anyOf) return prop.anyOf.find((b) => b.type !== "null")?.type;
  return undefined;
}

function canonicalTool(inputSchema: JsonSchema | undefined, annotations: Record<string, unknown> | undefined): unknown {
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

function makeMockManager(): OpenROADManager {
  return { listSessions: vi.fn().mockResolvedValue([]) } as unknown as OpenROADManager;
}

describe("tool-manifest parity with the Python server", () => {
  it("matches the golden tool manifest", async () => {
    const server = createMcpServer(makeMockManager());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test-client", version: "0.0.0" });
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

    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, unknown>;
    expect(manifest).toEqual(golden);
  });
});
