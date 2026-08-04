# Contributing to OpenROAD MCP

Thank you for contributing. This guide covers the TypeScript server, which is the active
distribution. The Python package under `python/` is deprecated and no longer published; it is
kept in the tree for reference only and will be removed in a future release.

---

## Requirements

- **Node.js 22+** (`node --version`)
- **npm** (bundled with Node)
- **OpenROAD** on your `PATH` for integration tests that spawn a real process

---

## Setting up the development environment

```bash
git clone https://github.com/The-OpenROAD-Project/openroad-mcp.git
cd openroad-mcp/typescript
npm install
npm run build
```

---

## Running the test suites

There are three suites. Run them individually during development and together before opening a PR.

```bash
# Unit tests (fast, no OpenROAD required)
npm run test

# With coverage report
npm run test:coverage

# Integration tests (require OpenROAD on PATH)
npm run test:integration

# Performance / memory benchmarks
npm run test:performance

# Everything at once
npm run test:all
```

Tests use [vitest](https://vitest.dev/). Configuration is in `typescript/vitest.config.ts`.

---

## Type checking and linting

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
```

Both must pass before a PR can merge.

---

## Golden fixtures

The files under `typescript/__tests__/golden/fixtures/` are the machine-readable wire contract
for tool responses. They are committed to the repo. Whenever you change a result model, an input
schema, or an annotation, regenerate them:

```bash
make golden
```

Then `git diff` to review the wire-level impact before committing. The CI `ts-check` job asserts
no fixture drift.

Golden fixtures were migrated to the TypeScript server in
[#155](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/155). The generator
is `typescript/__tests__/golden/generate_golden.ts`, invoked via `npm run generate:golden`.

---

## Making changes

### Branch naming

Use a short descriptive prefix:
- `feat/` for new features
- `fix/` for bug fixes
- `docs/` for documentation
- `ci/` for CI changes
- `chore/` for maintenance

### Commit messages

Follow the [Conventional Commits](https://www.conventionalcommits.org/) convention used by the
project. The release changelog generator categorises commits by prefix:
- `feat(...)` → Added
- `fix(...)` → Fixed
- `docs(...)`, `ci(...)`, `chore(...)`, `build(...)`, `test(...)` → Changed

Example: `fix(whitelist): handle backslash-escaped verbs in compound statements`

### Pull request checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm run test:all` passes
- [ ] `make golden && git diff --exit-code typescript/__tests__/golden/fixtures/` is clean
- [ ] New tools or schema changes are reflected in `docs/API.md`
- [ ] Security-relevant changes (whitelist, path containment, env vars) are reflected in `docs/SECURITY.md`

---

## Project structure

See [ARCHITECTURE.md](ARCHITECTURE.md) for a full module map. The key directories are:

```
typescript/src/
  config/    — CLI flags, settings, command whitelist
  core/      — OpenROADManager, result models
  interactive/ — Session, PTY handler, buffer
  tools/     — MCP tool implementations
  utils/     — ANSI decoder, path security, logging, cleanup
```

---

## Documentation

- **[docs/API.md](docs/API.md)** — reference for all 10 tools, params, response shapes
- **[docs/SECURITY.md](docs/SECURITY.md)** — whitelist model, env vars, HTTP exposure
- **[docs/TESTING.md](docs/TESTING.md)** — real-flow checklist for ORFS and AutoTuner comparison
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — module layout, data flow, session model

---

## MCP Inspector

Useful for iterating on tools without a full MCP client. Run `make install` once
first — `inspect` compiles via `ts-build`, which needs `typescript/node_modules`:

```bash
make install   # first time only
make inspect
```

---

## License

BSD 3-Clause. See [LICENSE](LICENSE).

---

## Python package (deprecated)

The `python/` directory contains the original Python/FastMCP implementation. It is no longer
published to PyPI and is not maintained for new features. Do not add Python-specific code or tests.
