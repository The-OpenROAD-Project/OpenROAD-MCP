import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

import { goldenDir } from "./golden_dir.js";
import { cases } from "./fixture_helpers.js";

// Wire-format serialization golden tests.
//
// Each entry in `cases` builds the TypeScript object through the production
// code path (toSnakeCase / zod.parse) and compares it to the committed JSON
// fixture in fixtures/. Any change to a model field name, null-vs-missing
// default, enum representation, or nesting breaks a test here.
//
// To update the fixtures after an intentional model change, run:
//   make golden   (or: cd typescript && npm run generate:golden)

const GOLDEN_DIR = goldenDir();

function golden(name: string): unknown {
  return JSON.parse(readFileSync(path.join(GOLDEN_DIR, `${name}.json`), "utf8"));
}

describe("wire-format schema golden tests", () => {
  for (const [name, build] of Object.entries(cases)) {
    it(`${name} matches the committed golden fixture`, () => {
      expect(build()).toEqual(golden(name));
    });
  }
});
