# Contributing to OpenROAD MCP

Thank you for contributing! This guide covers the OpenROAD MCP server.

## Review Priorities

Reviews are prioritized in this order:

### 1. Correctness & Security
Code must execute safely and securely.
- **Whitelist integrity:** Ensure any new Tcl commands are safely handled and do not bypass the command whitelist (`docs/SECURITY.md`).
- **Path traversal:** Avoid any possibility of reading outside `ORFS_FLOW_PATH` for report images.
- **Session management:** Ensure sessions properly clean up resources (PTYs) and don't leak memory on shutdown.

### 2. Protocol Adherence (Wire Contract)
The server must adhere strictly to the Model Context Protocol.
- **Golden Fixtures:** Any change to tool responses or inputs must be verified using `make golden`. The CI asserts no fixture drift to prevent breaking the wire contract.
- Tool schemas must accurately describe parameters so AI agents know how to call them.

### 3. Testing
Every code change should have accompanying tests.
- Unit tests for stateless logic.
- Integration tests for changes involving the OpenROAD subprocess or PTYs.
- Run `npm run test:all` to verify before PR submission.

### 4. Code Style & Quality
We enforce standard formatting and types.
- Types must strictly define the domain. Avoid `any`.
- Keep the `OpenROADManager` decoupled from MCP transports.
- Run `npm run typecheck` and `npm run lint` before committing.

---

## Development Setup

**Requirements:**
- **Node.js 22+**
- **npm** (bundled with Node)
- **OpenROAD** on your `PATH` for integration tests

**Getting Started:**
```bash
git clone https://github.com/The-OpenROAD-Project/openroad-mcp.git
cd openroad-mcp/typescript
npm install
npm run build
```

## Running Tests

Run these individually during development and together before opening a PR:

```bash
npm run test             # Unit tests (fast, no OpenROAD required)
npm run test:integration # Integration tests (require OpenROAD on PATH)
npm run test:performance # Performance / memory benchmarks
npm run test:all         # Run everything
```

*(Tests use [vitest](https://vitest.dev/). Configuration is in `typescript/vitest.config.ts`.)*

---

## Making Changes

### Branch Naming
Use a short descriptive prefix:
- `feat/` for new features
- `fix/` for bug fixes
- `docs/` for documentation
- `ci/` for CI changes
- `chore/` for maintenance

### Commit Messages
Follow the [Conventional Commits](https://www.conventionalcommits.org/) convention. The release changelog generator categorizes commits by prefix:
- `feat(...)` → Added
- `fix(...)` → Fixed
- `docs(...)`, `ci(...)`, `chore(...)`, `build(...)`, `test(...)` → Changed

*Example:* `fix(whitelist): handle backslash-escaped verbs in compound statements`

### Pull Request Checklist
- [ ] `npm run typecheck` and `npm run lint` pass.
- [ ] `npm run test:all` passes.
- [ ] `make golden` is run and `git diff` is clean (no unexpected fixture drift).
- [ ] New tools or schema changes are reflected in `docs/API.md`.
- [ ] Security-relevant changes are reflected in `docs/SECURITY.md`.

---

## Project Structure

See [ARCHITECTURE.md](ARCHITECTURE.md) for a full module map. Key directories under `typescript/src/`:

- `config/` — CLI flags, settings, command whitelist
- `core/` — `OpenROADManager`, result models
- `interactive/` — Session management, PTY handler, circular buffer
- `tools/` — MCP tool implementations
- `utils/` — ANSI decoding, path security, logging, cleanup

---

## For AI/LLM Code Reviewers

When reviewing OpenROAD MCP pull requests, follow the priority order above. Focus on correctness, security, and protocol adherence.

- **Check Whitelist Integrity:** Scrutinize changes to the Tcl execution pathway. Look for command injection or bypass vulnerabilities.
- **Check Wire Contract:** Ensure `make golden` diffs are intentional. If a tool schema changes, ensure it improves agent comprehension.
- **Resource Leaks:** Look closely at PTY spawning, buffer allocation, and session cleanup.
- **Ask Probing Questions:** "Does this accurately reflect the MCP spec?", "Will this strand PTY processes on termination?"
- **Be Concise:** Provide one-sentence feedback where possible. Avoid stylistic nitpicks that `eslint` or `prettier` handle automatically.
- **Don't generate summaries** of the PR unless asked. 

---

## License

BSD 3-Clause. See [LICENSE](LICENSE).
