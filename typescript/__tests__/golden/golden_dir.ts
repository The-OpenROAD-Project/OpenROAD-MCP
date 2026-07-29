import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Return the absolute path to the committed golden fixtures directory.
 *
 * Fixtures are co-located with the test helpers at
 * typescript/__tests__/golden/fixtures/ (source tree) and at
 * /app/__tests__/golden/fixtures/ inside the Docker test image (the whole
 * __tests__ tree is copied there by Dockerfile.ts).
 */
export function goldenDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
}
