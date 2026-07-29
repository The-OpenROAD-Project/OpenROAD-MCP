import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { goldenDir } from "./golden_dir.js";
import { createMcpServer } from "../../src/server.js";
import type { OpenROADManager } from "../../src/core/manager.js";
import { canonicalTool, type JsonSchema } from "./fixture_helpers.js";

// node-pty must never spawn during a list-tools check.
vi.mock("node-pty", () => ({ spawn: vi.fn() }));

// Tool-registration golden test.
//
// Boots the TypeScript MCP server in-memory, calls tools/list, normalizes
// each tool entry with canonicalTool() (collapses zod schema noise to base
// type + required flag), and asserts an exact match against the committed
// fixtures/tool_manifest.json. A renamed param, a flipped required flag, or
// a changed readOnly/destructive/idempotent annotation hint breaks this test.
//
// To update the fixture after an intentional tool-registration change, run:
//   make golden   (or: cd typescript && npm run generate:golden)

const GOLDEN = path.join(goldenDir(), "tool_manifest.json");

function makeMockManager(): OpenROADManager {
  return { listSessions: vi.fn().mockResolvedValue([]) } as unknown as OpenROADManager;
}

describe("tool-manifest golden test", () => {
  it("matches the committed golden tool_manifest.json", async () => {
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
