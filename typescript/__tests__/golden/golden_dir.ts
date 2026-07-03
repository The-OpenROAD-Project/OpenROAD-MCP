import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Locate the committed `tests/golden` fixtures by walking up from this file
 * until a `tests/golden` directory is found. This avoids a fragile fixed
 * relative depth: in the source tree the fixtures sit at `<repo>/tests/golden`
 * (three levels up from `typescript/__tests__/golden`), but inside the Docker
 * image the `typescript/` layer is collapsed into `/app`, so the depth differs.
 * Walking up resolves both.
 */
export function goldenDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "tests", "golden");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate tests/golden fixtures");
}
