import path from "node:path";
import fs from "node:fs";
import { ValidationError } from "../exceptions.js";

export function validatePathSegment(segment: string, segmentName: string): void {
  if (!segment || segment.trim() === "") throw new ValidationError(`${segmentName} cannot be empty`);
  if (segment === "." || segment === "..") throw new ValidationError(`${segmentName} cannot be '.' or '..'`);
  if (segment.includes("/") || segment.includes("\\")) throw new ValidationError(`${segmentName} cannot contain path separators`);
  if (segment.includes("\x00")) throw new ValidationError(`${segmentName} cannot contain null bytes`);
  if (/[*?[\]]/.test(segment)) throw new ValidationError(`${segmentName} cannot contain glob characters (* ? [ ])`);
}

export function validateSafePathContainment(targetPath: string, basePath: string, context: string): void {
  let resolvedTarget: string;
  let resolvedBase: string;

  try {
    resolvedBase = fs.realpathSync(basePath);
  } catch (e) {
    throw new ValidationError(`Failed to resolve ${context} path: ${e}`);
  }

  try {
    resolvedTarget = fs.realpathSync(targetPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ValidationError(`Failed to resolve ${context} path: ${e}`);
    }
    // Walk up to find the longest existing prefix, resolve its symlinks, then
    // re-append the non-existent suffix. A plain path.resolve() is unsafe here
    // because it won't resolve symlinks in existing parent directories, allowing
    // e.g. base/evil_link/nonexistent to escape containment at runtime.
    const suffix: string[] = [];
    let current = path.resolve(targetPath);
    for (;;) {
      const parent = path.dirname(current);
      if (parent === current) {
        resolvedTarget = path.resolve(targetPath);
        break;
      }
      suffix.unshift(path.basename(current));
      current = parent;
      try {
        resolvedTarget = path.join(fs.realpathSync(current), ...suffix);
        break;
      } catch (innerErr) {
        if ((innerErr as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new ValidationError(`Failed to resolve ${context} path: ${innerErr}`);
        }
      }
    }
  }

  const rel = path.relative(resolvedBase, resolvedTarget);
  const firstComponent = rel.split(path.sep)[0];
  if (firstComponent === ".." || path.isAbsolute(rel)) {
    throw new ValidationError(`${context} path ${targetPath} is not contained within ${basePath}`);
  }
}
