import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { OpenROADManager } from "../core/manager.js";
import {
  ImageInfo,
  ImageMetadata,
  ListImagesResult,
  ReadImageResult,
} from "../core/models.js";
import { ValidationError } from "../exceptions.js";
import {
  validatePathSegment,
  validateSafePathContainment,
} from "../utils/path_security.js";
import { getSettings } from "../config/settings.js";
import { getLogger } from "../utils/logging.js";
import { BaseTool } from "./base.js";

const logger = getLogger("tools.report_images");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BASE64_SIZE_KB = 15;
const MAX_IMAGE_SIZE_MB = 50;

// ---------------------------------------------------------------------------
// Image type mapping (exact copy of Python dict)
// ---------------------------------------------------------------------------

const IMAGE_TYPE_MAPPING: Record<string, string> = {
  cts_clk: "clock_visualization",
  cts_clk_layout: "clock_layout",
  cts_core_clock: "core_clock_visualization",
  cts_core_clock_layout: "core_clock_layout",
  final_all: "complete_design",
  final_clocks: "clock_routing",
  final_congestion: "congestion_heatmap",
  final_ir_drop: "ir_drop_analysis",
  final_placement: "cell_placement",
  final_resizer: "resizer_results",
  final_routing: "routing_visualization",
};

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Derive the image stage and semantic type from a filename.
 * Returns ["unknown", "unknown"] for files with no underscore or unrecognised keys.
 */
export function classifyImageType(filename: string): [string, string] {
  const basename = path.basename(filename, path.extname(filename));
  const underscoreIdx = basename.indexOf("_");
  let stage: string;
  let key: string;
  if (underscoreIdx === -1) {
    stage = "unknown";
    key = basename;
  } else {
    stage = basename.slice(0, underscoreIdx);
    key = basename;
  }
  const type = IMAGE_TYPE_MAPPING[key] ?? "unknown";
  return [stage, type];
}

/**
 * Verify that `platform` and `design` are known in the current ORFS configuration.
 * Throws ValidationError when either is not found.
 */
export function validatePlatformDesign(platform: string, design: string): void {
  const settings = getSettings();
  const platforms = settings.platforms;
  if (!platforms.includes(platform)) {
    throw new ValidationError(
      `Platform '${platform}' not found. Available platforms: ${platforms.join(", ") || "none"}`,
    );
  }
  const designs = settings.designs(platform);
  if (!designs.includes(design)) {
    throw new ValidationError(
      `Design '${design}' not found for platform '${platform}'. Available designs: ${designs.join(", ") || "none"}`,
    );
  }
}

/**
 * Resolve and validate the reports base path and per-run sub-directory.
 * Returns [reportsBase, runPath] as absolute path strings.
 */
function resolveRunPath(
  platform: string,
  design: string,
  runSlug: string,
): [string, string] {
  validatePlatformDesign(platform, design);
  validatePathSegment(runSlug, "run_slug");
  const settings = getSettings();
  const reportsBase = path.join(settings.flowPath, "reports", platform, design);
  const runPath = path.join(reportsBase, runSlug);
  validateSafePathContainment(runPath, reportsBase, "run directory");
  return [reportsBase, runPath];
}

/** List available run slugs in reportsBase for error messages. */
function availableRuns(reportsBase: string): string[] {
  try {
    return fs
      .readdirSync(reportsBase, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Recursively find all .webp files under `dir`, returning absolute paths.
 * Requires Node.js ≥ 20 for the `recursive` option on readdirSync.
 */
function findWebpFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".webp"))
    .map((e) => {
      // `parentPath` is available in Node 20.12+; `path` is the older alias.
      const parent = (e as unknown as { parentPath?: string; path?: string })
        .parentPath ?? (e as unknown as { path: string }).path;
      return path.join(parent, e.name);
    });
}

interface CompressResult {
  imageBytes: Buffer;
  compressionApplied: boolean;
  originalSize: number;
  compressedSize: number;
  originalWidth: number | null;
  originalHeight: number | null;
  width: number | null;
  height: number | null;
}

/**
 * Load an image and compress it to fit within `maxSizeKb` of base64 output.
 * Uses sharp for resizing (lanczos3) and WebP encoding (quality=85).
 * Falls back to returning raw bytes when sharp fails, with null dimensions.
 */
async function loadAndCompressImage(
  imagePath: string,
  maxSizeKb: number = MAX_BASE64_SIZE_KB,
): Promise<CompressResult> {
  const originalSize = fs.statSync(imagePath).size;
  const estimatedBase64 = Math.floor((originalSize * 4) / 3);

  if (estimatedBase64 / 1024 <= maxSizeKb) {
    try {
      const rawBytes = fs.readFileSync(imagePath);
      const meta = await sharp(imagePath).metadata();
      return {
        imageBytes: rawBytes,
        compressionApplied: false,
        originalSize,
        compressedSize: originalSize,
        originalWidth: meta.width ?? null,
        originalHeight: meta.height ?? null,
        width: meta.width ?? null,
        height: meta.height ?? null,
      };
    } catch (e) {
      logger.warn({ err: e, imagePath }, "sharp.metadata() failed on small image; returning raw bytes with null dims");
      return {
        imageBytes: fs.readFileSync(imagePath),
        compressionApplied: false,
        originalSize,
        compressedSize: originalSize,
        originalWidth: null,
        originalHeight: null,
        width: null,
        height: null,
      };
    }
  }

  try {
    const targetBytes = Math.floor((maxSizeKb * 1024 * 3) / 4);
    const scale = Math.sqrt(targetBytes / originalSize);
    const meta = await sharp(imagePath).metadata();
    if (!meta.width || !meta.height) {
      throw new Error("Image dimensions unavailable");
    }
    const origW = meta.width;
    const origH = meta.height;
    const newW = Math.max(Math.round(origW * scale), 256);
    const newH = Math.max(Math.round(origH * scale), 256);
    const compressed = await sharp(imagePath)
      .resize(newW, newH, { kernel: "lanczos3" })
      .webp({ quality: 85 })
      .toBuffer();
    return {
      imageBytes: compressed,
      compressionApplied: true,
      originalSize,
      compressedSize: compressed.length,
      originalWidth: meta.width ?? null,
      originalHeight: meta.height ?? null,
      width: newW,
      height: newH,
    };
  } catch (e) {
    logger.warn({ err: e, imagePath }, "Image compression failed; returning raw bytes with null dims");
    return {
      imageBytes: fs.readFileSync(imagePath),
      compressionApplied: false,
      originalSize,
      compressedSize: originalSize,
      originalWidth: null,
      originalHeight: null,
      width: null,
      height: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool classes
// ---------------------------------------------------------------------------

/** Lists .webp report images for a specific platform/design/run. */
export class ListReportImagesTool extends BaseTool {
  constructor(manager: OpenROADManager) {
    super(manager);
  }

  async execute(
    platform: string,
    design: string,
    runSlug: string,
    stage = "all",
  ): Promise<string> {
    let reportsBase: string;
    let runPath: string;

    try {
      [reportsBase, runPath] = resolveRunPath(platform, design, runSlug);
    } catch (e) {
      if (e instanceof ValidationError) {
        return this.formatResult(
          ListImagesResult.parse({
            error: e.constructor.name,
            message: e.message,
          }) as unknown as Record<string, unknown>,
        );
      }
      return this.formatResult(
        ListImagesResult.parse({
          error: "UnexpectedError",
          message: (e as Error).message ?? String(e),
        }) as unknown as Record<string, unknown>,
      );
    }

    if (!fs.existsSync(runPath)) {
      const runs = availableRuns(reportsBase);
      return this.formatResult(
        ListImagesResult.parse({
          error: "RunNotFound",
          message: `Run directory '${runSlug}' not found. Available runs: ${runs.join(", ") || "none"}`,
        }) as unknown as Record<string, unknown>,
      );
    }

    try {
      let files: string[];
      try {
        files = findWebpFiles(runPath);
      } catch {
        files = [];
      }

      if (files.length === 0) {
        return this.formatResult(
          ListImagesResult.parse({
            runPath,
            totalImages: 0,
            imagesByStage: {},
          }) as unknown as Record<string, unknown>,
        );
      }

      const imagesByStage: Record<string, unknown[]> = {};
      let total = 0;

      for (const filePath of files) {
        const filename = path.basename(filePath);
        const [fileStage, type] = classifyImageType(filename);
        if (stage !== "all" && stage !== fileStage) continue;

        const stat = fs.statSync(filePath);
        const imageInfo = ImageInfo.parse({
          filename,
          path: filePath,
          sizeBytes: stat.size,
          modifiedTime: stat.mtime.toISOString(),
          type,
        });

        const bucket = imagesByStage[fileStage] ?? [];
        bucket.push(imageInfo);
        imagesByStage[fileStage] = bucket;
        total++;
      }

      // Sort each stage bucket by filename
      for (const key of Object.keys(imagesByStage)) {
        imagesByStage[key] = (imagesByStage[key] as Array<{ filename: string }>).sort((a, b) =>
          a.filename.localeCompare(b.filename),
        );
      }

      return this.formatResult(
        ListImagesResult.parse({
          runPath,
          totalImages: total,
          imagesByStage,
        }) as unknown as Record<string, unknown>,
      );
    } catch (e) {
      return this.formatResult(
        ListImagesResult.parse({
          error: "UnexpectedError",
          message: (e as Error).message ?? String(e),
        }) as unknown as Record<string, unknown>,
      );
    }
  }
}

/** Reads, optionally compresses, and base64-encodes a single report image. */
export class ReadReportImageTool extends BaseTool {
  constructor(manager: OpenROADManager) {
    super(manager);
  }

  async execute(
    platform: string,
    design: string,
    runSlug: string,
    imageName: string,
  ): Promise<string> {
    let reportsBase: string;
    let runPath: string;

    try {
      [reportsBase, runPath] = resolveRunPath(platform, design, runSlug);
    } catch (e) {
      if (e instanceof ValidationError) {
        return this.formatResult(
          ReadImageResult.parse({
            error: e.constructor.name,
            message: e.message,
          }) as unknown as Record<string, unknown>,
        );
      }
      return this.formatResult(
        ReadImageResult.parse({
          error: "UnexpectedError",
          message: (e as Error).message ?? String(e),
        }) as unknown as Record<string, unknown>,
      );
    }

    try {
      validatePathSegment(imageName, "image_name");
    } catch (e) {
      return this.formatResult(
        ReadImageResult.parse({
          error: (e as ValidationError).constructor.name,
          message: (e as Error).message,
        }) as unknown as Record<string, unknown>,
      );
    }

    if (!imageName.endsWith(".webp")) {
      return this.formatResult(
        ReadImageResult.parse({
          error: "InvalidImageName",
          message: `Image '${imageName}' must have a .webp extension`,
        }) as unknown as Record<string, unknown>,
      );
    }

    if (!fs.existsSync(runPath)) {
      const runs = availableRuns(reportsBase);
      return this.formatResult(
        ReadImageResult.parse({
          error: "RunNotFound",
          message: `Run directory '${runSlug}' not found. Available runs: ${runs.join(", ") || "none"}`,
        }) as unknown as Record<string, unknown>,
      );
    }

    const imagePath = path.join(runPath, imageName);

    try {
      validateSafePathContainment(imagePath, runPath, "image file");
    } catch (e) {
      return this.formatResult(
        ReadImageResult.parse({
          error: (e as ValidationError).constructor.name,
          message: (e as Error).message,
        }) as unknown as Record<string, unknown>,
      );
    }

    if (!fs.existsSync(imagePath)) {
      let available: string[] = [];
      try {
        available = findWebpFiles(runPath).map((f) => path.basename(f));
      } catch {
        available = [];
      }
      return this.formatResult(
        ReadImageResult.parse({
          error: "ImageNotFound",
          message: `Image '${imageName}' not found. Available images: ${available.join(", ") || "none"}`,
        }) as unknown as Record<string, unknown>,
      );
    }

    const stat = fs.statSync(imagePath);
    if (!stat.isFile()) {
      return this.formatResult(
        ReadImageResult.parse({
          error: "NotAFile",
          message: `'${imageName}' is not a regular file`,
        }) as unknown as Record<string, unknown>,
      );
    }

    if (stat.size > MAX_IMAGE_SIZE_MB * 1024 * 1024) {
      return this.formatResult(
        ReadImageResult.parse({
          error: "FileTooLarge",
          message: `Image '${imageName}' exceeds the ${MAX_IMAGE_SIZE_MB} MB size limit`,
        }) as unknown as Record<string, unknown>,
      );
    }

    try {
      const r = await loadAndCompressImage(imagePath);
      const imageData = r.imageBytes.toString("base64");
      const [stage, type] = classifyImageType(imageName);
      const compressionRatio =
        r.compressionApplied && r.compressedSize > 0
          ? r.originalSize / r.compressedSize
          : null;

      const metadata = ImageMetadata.parse({
        filename: imageName,
        format: "webp",
        sizeBytes: r.compressedSize,
        width: r.width,
        height: r.height,
        modifiedTime: stat.mtime.toISOString(),
        stage,
        type,
        compressionApplied: r.compressionApplied,
        originalSizeBytes: r.compressionApplied ? r.originalSize : null,
        originalWidth: r.originalWidth,
        originalHeight: r.originalHeight,
        compressionRatio,
      });

      return this.formatResult(
        ReadImageResult.parse({
          imageData,
          metadata,
        }) as unknown as Record<string, unknown>,
      );
    } catch (e) {
      if (e instanceof ValidationError) {
        return this.formatResult(
          ReadImageResult.parse({
            error: e.constructor.name,
            message: e.message,
          }) as unknown as Record<string, unknown>,
        );
      }
      return this.formatResult(
        ReadImageResult.parse({
          error: "UnexpectedError",
          message: (e as Error).message ?? String(e),
        }) as unknown as Record<string, unknown>,
      );
    }
  }
}

