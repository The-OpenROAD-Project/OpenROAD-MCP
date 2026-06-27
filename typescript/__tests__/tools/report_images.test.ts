import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyImageType,
  ListReportImagesTool,
  ReadReportImageTool,
  validatePlatformDesign,
} from "../../src/tools/report_images.js";
import type { OpenROADManager } from "../../src/core/manager.js";

// Mock getSettings so tests do not depend on a filesystem ORFS install.
vi.mock("../../src/config/settings.js", () => {
  let mockFlowPath = "/mock/flow";
  let mockPlatforms: string[] = [];
  let mockDesigns: Record<string, string[]> = {};
  return {
    getSettings: vi.fn(() => ({
      get flowPath() { return mockFlowPath; },
      get platforms() { return mockPlatforms; },
      designs(platform: string) { return mockDesigns[platform] ?? []; },
      WHITELIST_ENABLED: false,
      LOG_LEVEL: "INFO",
      COMMAND_TIMEOUT: 30,
      COMMAND_COMPLETION_DELAY: 0.1,
      DEFAULT_BUFFER_SIZE: 131072,
      MAX_SESSIONS: 50,
      SESSION_QUEUE_SIZE: 128,
      SESSION_IDLE_TIMEOUT: 300,
      READ_CHUNK_SIZE: 8192,
      LOG_FORMAT: "",
      ALLOWED_COMMANDS: ["openroad"],
      ENABLE_COMMAND_VALIDATION: true,
      ORFS_FLOW_PATH: "/mock/flow",
    })),
    __setMock(fp: string, plats: string[], des: Record<string, string[]>) {
      mockFlowPath = fp;
      mockPlatforms = plats;
      mockDesigns = des;
    },
  };
});

import { getSettings } from "../../src/config/settings.js";

let tmpDir: string;

function createFixture(
  platform = "nangate45",
  design = "gcd",
  runSlug = "run-123",
  imageFiles: string[] = ["cts_clk.webp", "final_all.webp"],
) {
  const flowPath = tmpDir;
  fs.mkdirSync(path.join(flowPath, "platforms", platform), { recursive: true });
  fs.mkdirSync(path.join(flowPath, "designs", platform, design), { recursive: true });
  const runPath = path.join(flowPath, "reports", platform, design, runSlug);
  fs.mkdirSync(runPath, { recursive: true });
  for (const img of imageFiles) {
    fs.writeFileSync(path.join(runPath, img), Buffer.from("RIFF\x00\x00\x00\x00WEBP"));
  }
  return { flowPath, runPath };
}

// Constructor requires a manager but the tools never invoke it.
const stubManager = {} as unknown as OpenROADManager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openroad-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("classifyImageType", () => {
  it("classifies CTS images correctly", () => {
    expect(classifyImageType("cts_clk.webp")).toEqual(["cts", "clock_visualization"]);
    expect(classifyImageType("cts_clk_layout.webp")).toEqual(["cts", "clock_layout"]);
    expect(classifyImageType("cts_core_clock.webp")).toEqual(["cts", "core_clock_visualization"]);
  });

  it("classifies final stage images correctly", () => {
    expect(classifyImageType("final_all.webp")).toEqual(["final", "complete_design"]);
    expect(classifyImageType("final_congestion.webp")).toEqual(["final", "congestion_heatmap"]);
    expect(classifyImageType("final_ir_drop.webp")).toEqual(["final", "ir_drop_analysis"]);
  });

  it("returns unknown for unrecognised filenames", () => {
    expect(classifyImageType("unknown_image.webp")).toEqual(["unknown", "unknown"]);
    expect(classifyImageType("foo.webp")).toEqual(["unknown", "unknown"]);
  });

  it("returns unknown stage when filename has no underscore", () => {
    const [stage, _type] = classifyImageType("nounderscore.webp");
    expect(stage).toBe("unknown");
  });
});

describe("validatePlatformDesign", () => {
  it("throws on unknown platform", () => {
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      platforms: ["nangate45"],
      designs: () => ["gcd"],
      flowPath: tmpDir,
    });
    expect(() => validatePlatformDesign("bad_platform", "gcd")).toThrow();
  });

  it("throws on unknown design", () => {
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath: tmpDir,
    });
    expect(() => validatePlatformDesign("nangate45", "bad_design")).toThrow();
  });
});

describe("ListReportImagesTool", () => {
  let tool: ListReportImagesTool;

  beforeEach(() => {
    tool = new ListReportImagesTool(stubManager);
  });

  it("returns error when platform is invalid", async () => {
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      platforms: [],
      designs: () => [],
      flowPath: tmpDir,
    });
    const raw = await tool.execute("bad_platform", "gcd", "run-123");
    const result = JSON.parse(raw);
    expect(result.error).toBeTruthy();
  });

  it("returns RunNotFound error when run directory does not exist", async () => {
    const { flowPath } = createFixture();
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const raw = await tool.execute("nangate45", "gcd", "nonexistent");
    const result = JSON.parse(raw);
    expect(result.error).toBe("RunNotFound");
  });

  it("returns totalImages 0 when run directory has no .webp files", async () => {
    const { flowPath } = createFixture("nangate45", "gcd", "run-empty", []);
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const raw = await tool.execute("nangate45", "gcd", "run-empty");
    const result = JSON.parse(raw);
    expect(result.total_images).toBe(0);
    expect(result.images_by_stage).toEqual({});
  });

  it("lists all .webp files grouped by stage", async () => {
    const { flowPath } = createFixture();
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const raw = await tool.execute("nangate45", "gcd", "run-123");
    const result = JSON.parse(raw);
    expect(result.total_images).toBe(2);
    expect(result.images_by_stage).toBeTruthy();
    expect(result.images_by_stage).toHaveProperty("cts");
    expect(result.images_by_stage).toHaveProperty("final");
  });

  it("does not descend symlinked directories or list symlinked files", async () => {
    const { flowPath, runPath } = createFixture("nangate45", "gcd", "run-123", [
      "cts_clk.webp",
    ]);
    // A directory of images outside the run, reachable only via symlinks.
    const outside = path.join(tmpDir, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "final_all.webp"), Buffer.from("RIFF\x00\x00\x00\x00WEBP"));
    try {
      fs.symlinkSync(outside, path.join(runPath, "linkdir"));
      fs.symlinkSync(path.join(outside, "final_all.webp"), path.join(runPath, "linkfile.webp"));
    } catch {
      // symlink creation may fail in some environments; skip gracefully.
      return;
    }
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const result = JSON.parse(await tool.execute("nangate45", "gcd", "run-123"));
    // Only the real cts_clk.webp is found; nothing reached through a symlink.
    expect(result.total_images).toBe(1);
    expect(result.images_by_stage).toHaveProperty("cts");
    expect(result.images_by_stage).not.toHaveProperty("final");
  });

  it("filters images by stage", async () => {
    const { flowPath } = createFixture("nangate45", "gcd", "run-123", [
      "cts_clk.webp",
      "final_all.webp",
    ]);
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const raw = await tool.execute("nangate45", "gcd", "run-123", "cts");
    const result = JSON.parse(raw);
    expect(result.total_images).toBe(1);
    expect(result.images_by_stage).toHaveProperty("cts");
    expect(result.images_by_stage).not.toHaveProperty("final");
  });
});

describe("ReadReportImageTool", () => {
  let tool: ReadReportImageTool;

  beforeEach(() => {
    tool = new ReadReportImageTool(stubManager);
  });

  it("returns error when platform is invalid", async () => {
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      platforms: [],
      designs: () => [],
      flowPath: tmpDir,
    });
    const raw = await tool.execute("bad_platform", "gcd", "run-123", "cts_clk.webp");
    const result = JSON.parse(raw);
    expect(result.error).toBeTruthy();
    expect(result.image_data).toBeNull();
  });

  it("returns RunNotFound when run directory does not exist", async () => {
    const { flowPath } = createFixture();
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const raw = await tool.execute("nangate45", "gcd", "missing-run", "cts_clk.webp");
    const result = JSON.parse(raw);
    expect(result.error).toBe("RunNotFound");
  });

  it("returns ImageNotFound when image does not exist", async () => {
    const { flowPath } = createFixture();
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const raw = await tool.execute("nangate45", "gcd", "run-123", "missing.webp");
    const result = JSON.parse(raw);
    expect(result.error).toBe("ImageNotFound");
  });

  it("reads and base64-encodes a .webp image successfully", async () => {
    const { flowPath } = createFixture("nangate45", "gcd", "run-123", ["cts_clk.webp"]);
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const raw = await tool.execute("nangate45", "gcd", "run-123", "cts_clk.webp");
    const result = JSON.parse(raw);
    expect(typeof result.image_data).toBe("string");
    expect(result.image_data.length).toBeGreaterThan(0);
    const decoded = Buffer.from(result.image_data, "base64");
    expect(decoded.length).toBeGreaterThan(0);
    expect(result.metadata).toBeTruthy();
    expect(result.metadata.filename).toBe("cts_clk.webp");
    expect(result.metadata.stage).toBe("cts");
    expect(result.metadata.type).toBe("clock_visualization");
  });

  it("returns FileTooLarge error when image exceeds 50 MB", async () => {
    const { flowPath, runPath } = createFixture("nangate45", "gcd", "run-123", []);
    const bigPath = path.join(runPath, "huge.webp");
    fs.writeFileSync(bigPath, Buffer.from("tiny content"));
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const originalStatSync = fs.statSync.bind(fs);
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation((p) => {
      if (p === bigPath) return { size: 51 * 1024 * 1024, isFile: () => true, mtime: new Date() } as unknown as fs.Stats;
      return originalStatSync(p) as fs.Stats;
    });
    const raw = await tool.execute("nangate45", "gcd", "run-123", "huge.webp");
    const result = JSON.parse(raw);
    expect(result.error).toBe("FileTooLarge");
    statSpy.mockRestore();
  });

  it("rejects non-.webp extension", async () => {
    const { flowPath } = createFixture();
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    const raw = await tool.execute("nangate45", "gcd", "run-123", "cts_clk.png");
    const result = JSON.parse(raw);
    expect(result.error).toBe("InvalidImageName");
  });
});

describe("TestPathTraversalSecurity", () => {
  let tool: ListReportImagesTool;
  let readTool: ReadReportImageTool;
  let flowPath: string;

  beforeEach(() => {
    const fixture = createFixture();
    flowPath = fixture.flowPath;
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath,
      WHITELIST_ENABLED: false,
    });
    tool = new ListReportImagesTool(stubManager);
    readTool = new ReadReportImageTool(stubManager);
  });

  it("rejects path traversal in run_slug (../../etc/passwd)", async () => {
    const raw = await tool.execute("nangate45", "gcd", "../../../etc/passwd");
    const result = JSON.parse(raw);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toBe("RunNotFound"); // must be a validation error
  });

  it("rejects bare '..' as run_slug", async () => {
    const raw = await tool.execute("nangate45", "gcd", "..");
    const result = JSON.parse(raw);
    expect(result.error).toBeTruthy();
  });

  it("rejects glob characters in run_slug", async () => {
    const raw = await tool.execute("nangate45", "gcd", "*");
    const result = JSON.parse(raw);
    expect(result.error).toBeTruthy();
  });

  it("rejects path traversal in image_name", async () => {
    const raw = await readTool.execute("nangate45", "gcd", "run-123", "../../../etc/passwd");
    const result = JSON.parse(raw);
    expect(result.error).toBeTruthy();
  });

  it("rejects non-.webp extension in image_name", async () => {
    const raw = await readTool.execute("nangate45", "gcd", "run-123", "file.sh");
    const result = JSON.parse(raw);
    expect(result.error).toBe("InvalidImageName");
  });

  it("rejects null byte in image_name", async () => {
    const raw = await readTool.execute("nangate45", "gcd", "run-123", "evil\x00.webp");
    const result = JSON.parse(raw);
    expect(result.error).toBeTruthy();
  });

  it("blocks symlink escape from run directory", async () => {
    const runPath = path.join(flowPath, "reports", "nangate45", "gcd", "run-123");
    const linkPath = path.join(runPath, "escape.webp");
    try {
      fs.symlinkSync("/etc/passwd", linkPath);
    } catch {
      // symlink creation may fail in some environments; skip gracefully.
      return;
    }
    const raw = await readTool.execute("nangate45", "gcd", "run-123", "escape.webp");
    const result = JSON.parse(raw);
    // Should not find the image, reject path containment, or return an error
    // and must NOT return valid image_data resolving to /etc/passwd content.
    expect(result.image_data === null || result.error !== null).toBe(true);
  });
});

describe("TestPlatformDesignValidationInTools", () => {
  beforeEach(() => {
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      platforms: ["nangate45"],
      designs: (p: string) => (p === "nangate45" ? ["gcd"] : []),
      flowPath: tmpDir,
      WHITELIST_ENABLED: false,
    });
  });

  it("list tool returns error for invalid platform", async () => {
    const raw = await new ListReportImagesTool(stubManager).execute("invalid_plat", "gcd", "run-123");
    expect(JSON.parse(raw).error).toBeTruthy();
  });

  it("list tool returns error for invalid design", async () => {
    const raw = await new ListReportImagesTool(stubManager).execute("nangate45", "bad_design", "run-123");
    expect(JSON.parse(raw).error).toBeTruthy();
  });

  it("read tool returns error for invalid platform", async () => {
    const raw = await new ReadReportImageTool(stubManager).execute("invalid_plat", "gcd", "run-123", "img.webp");
    expect(JSON.parse(raw).error).toBeTruthy();
  });

  it("read tool returns error for invalid design", async () => {
    const raw = await new ReadReportImageTool(stubManager).execute("nangate45", "bad_design", "run-123", "img.webp");
    expect(JSON.parse(raw).error).toBeTruthy();
  });
});
