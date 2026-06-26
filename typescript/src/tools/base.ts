import type { OpenROADManager } from "../core/manager.js";

function camelToSnakeKey(key: string): string {
  return key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

/**
 * Recursively convert camelCase object keys to snake_case. Idempotent on
 * already-snake_case keys, so opaque snake_case payloads pass through
 * unchanged.
 */
export function toSnakeCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnakeCase);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        camelToSnakeKey(k),
        toSnakeCase(v),
      ]),
    );
  }
  return value;
}

/**
 * Base class for MCP tool implementations. Provides the manager dependency
 * and a serialization helper that converts the camelCase domain model to the
 * snake_case wire format.
 */
export abstract class BaseTool {
  protected constructor(protected readonly manager: OpenROADManager) {}

  protected formatResult(result: Record<string, unknown>): string {
    return JSON.stringify(toSnakeCase(result));
  }
}
