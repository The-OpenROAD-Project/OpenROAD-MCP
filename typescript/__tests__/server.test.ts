import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";
import type { OpenROADManager } from "../src/core/manager.js";

// node-pty must never spawn during a boot/list-tools smoke test.
vi.mock("node-pty", () => ({ spawn: vi.fn() }));

const EXPECTED_TOOLS = [
  "interactive_openroad_query",
  "interactive_openroad_exec",
  "list_interactive_sessions",
  "create_interactive_session",
  "terminate_interactive_session",
  "inspect_interactive_session",
  "get_session_history",
  "get_session_metrics",
  "list_report_images",
  "read_report_image",
].sort();

/** Minimal manager stub: listing tools needs no calls; one round-trip uses listSessions. */
function makeMockManager(): OpenROADManager {
  return {
    listSessions: vi.fn().mockResolvedValue([]),
  } as unknown as OpenROADManager;
}

async function connectClient(manager: OpenROADManager): Promise<Client> {
  const server = createMcpServer(manager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("createMcpServer over MCP", () => {
  it("enumerates exactly the 10 expected tools", async () => {
    const client = await connectClient(makeMockManager());
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    await client.close();
  });

  it("carries the correct behaviour annotations", async () => {
    const client = await connectClient(makeMockManager());
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    expect(byName.get("interactive_openroad_query")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(byName.get("interactive_openroad_exec")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(byName.get("list_interactive_sessions")?.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    });
    await client.close();
  });

  it("round-trips a tool call returning a JSON string in text content", async () => {
    const manager = makeMockManager();
    const client = await connectClient(manager);

    const result = await client.callTool({ name: "list_interactive_sessions" });
    const content = result.content as Array<{ type: string; text: string }>;

    expect(content[0]?.type).toBe("text");
    const parsed = JSON.parse(content[0]!.text) as { sessions: unknown[]; total_count: number };
    expect(parsed.sessions).toEqual([]);
    expect(parsed.total_count).toBe(0);
    expect(manager.listSessions).toHaveBeenCalledOnce();
    await client.close();
  });
});
