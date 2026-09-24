import { describe, it, expect, vi } from "vitest";
import * as tools from "../../src/tools/index.js";
import { compareGate, evaluateGates } from "../../src/tools/orfs_metrics.js";

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

describe("tools index", () => {
  it("still exports the deprecated gate helpers", () => {
    expect(tools.evaluateGates).toBe(evaluateGates);
    expect(tools.compareGate).toBe(compareGate);
  });
});
