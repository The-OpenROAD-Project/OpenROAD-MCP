## Requirement


The MCP server ecosystem has settled on two dominant distribution channels: `npx` for TypeScript/Node.js servers and `uvx` for Python servers. The MCP registry, Smithery, and most community tutorials default to `npx` examples. This creates a discoverability and onboarding gap: a user following any generic "add an MCP server" guide will expect `npx`, and encountering `uvx` adds a step that filters out users who don't already have Python 3.13 and `uv` installed.


The core question is not whether TypeScript is "better", the current Python implementation is clean, well-typed, and correct. The question is whether the distribution and ecosystem benefits of `npx` justify the cost and risk of a full language migration.

## Section 1: Current State - What Exactly Would Be Migrated

### Codebase Size


| Module | Lines | Migration Complexity |
|---|---|---|
| `interactive/session.py` | 620 | **HIGH** - asyncio tasks, event-driven I/O |
| `tools/interactive.py` | 376 | Medium - direct tool port |
| `core/manager.py` | 352 | Medium - session lifecycle |
| `tools/report_images.py` | 321 | Medium - PIL image ops |
| `interactive/pty_handler.py` | 282 | **HIGH** - POSIX-only (`pty`, `termios`, `fcntl`) |
| `server.py` | 263 | Low - framework swap |
| `config/command_whitelist.py` | 209 | Low - direct port |
| `utils/ansi_decoder.py` | 208 | Low - direct port |
| `core/models.py` | 200 | Low - Pydantic -> Zod |
| `config/cli.py` | 123 | Low - CLI args |
| `config/settings.py` | 119 | Low - env var config |
| `utils/cleanup.py` | 115 | Low - signal handlers |
| `interactive/buffer.py` | 163 | Medium - async buffer |
| Other (constants, exceptions, utils) | ~100 | Low |
| **Total** | **~3,450 lines** | |


Tests are a separate concern: 5,243+ lines across 40+ test files in 5 categories (cli, integration, interactive, performance, tools). These must all be rewritten in Vitest/Jest.


### 10 MCP Tools That Must Have Identical Behavior


1. `interactive_openroad_query` - read-only PTY command execution
2. `interactive_openroad_exec` - state-modifying PTY command execution
3. `create_interactive_session` - spawn new OpenROAD PTY process
4. `list_interactive_sessions` - enumerate sessions with status
5. `terminate_interactive_session` - SIGTERM/SIGKILL a session
6. `inspect_interactive_session` - detailed session metrics (CPU, memory, buffer)
7. `get_session_history` - command history with search/filter
8. `get_session_metrics` - aggregate metrics across all sessions
9. `list_report_images` - ORFS report directory traversal
10. `read_report_image` - image loading, compression, base64 encoding


### What Makes This Hard: The PTY Stack


The single hardest part of this migration is the PTY subsystem. The Python implementation uses:


```python
# These are POSIX-only standard library modules - no Windows equivalents
import pty          # Creates master/slave file descriptor pair
import termios      # Configures terminal attributes (echo, canonical mode, etc.)
import fcntl        # Sets non-blocking I/O on the master FD
import os           # setsid() creates new process session
```


This code creates a true terminal emulator: the OpenROAD process thinks it's running in a real terminal (xterm-256color), which affects its output formatting. The PTY handler runs background asyncio tasks to drain the master FD continuously, buffers output in a custom 128KB circular buffer with eviction, and uses an async event for completion detection.


The TypeScript equivalent is `node-pty` (owned by Microsoft, used inside VS Code Terminal). It provides a cleaner API but different semantics. There is a working precedent: `@so2liu/pty-mcp-server` on npm demonstrates `node-pty` + `@modelcontextprotocol/sdk` working together. `node-pty` has been confirmed to work cross-platform, including Windows - which the current Python code cannot do at all.


---


## Section 2: Scope of Refactor - Incremental vs. Full


There are three migration strategies, with meaningfully different risk/cost profiles.


### Option A: Thin Node.js Wrapper (Pseudo-npx)


Create a minimal npm package (`openroad-mcp`) whose only job is to check for Python/uv and spawn the Python process:


```typescript
// bin/openroad-mcp.ts (the entire package)
import { spawn } from 'child_process';
import { which } from 'which';


const uv = await which('uv').catch(() => null);
if (!uv) {
 console.error('uv not found. Install: curl -LsSf https://astral.sh/uv/install.sh | sh');
 process.exit(1);
}


const proc = spawn('uvx', ['--from', 'openroad-mcp', 'openroad-mcp', ...process.argv.slice(2)], {
 stdio: 'inherit'
});
proc.on('exit', code => process.exit(code ?? 1));
```


**Result:** Users run `npx openroad-mcp` and get the Python server, transparently.


**Pros:** Faster to implement, zero logic risk, immediate npx support, can be deprecated later. 
**Cons:** Still requires Python 3.13 + uv. The `npx` win is cosmetic. Users who don't have uv get a confusing error through a new indirection layer. Does not solve Windows compatibility.


**Verdict:** It is a stopgap, not a solution. Worth doing if we want `npx` *this sprint*. It should be treated as a transitional fallback path, not the v1.0 architecture.


---


### Option B: Full TypeScript Rewrite (True migration)


A complete ground-up TypeScript implementation. All 3,450 lines of Python become TypeScript. All tests become Vitest tests. The CI, Docker, and packaging pipelines are rebuilt.

All 10 tool names and their input/output JSON schemas remain identical. Users' `mcp.json` configs and AI prompts continue working without change.


#### Layer-by-layer rewrite map


**Layer 1: Infrastructure**


| Python | TypeScript equivalent | Notes |
|---|---|---|
| `pty`, `termios`, `fcntl` | `node-pty` | Microsoft-maintained, used in VS Code |
| `asyncio.Queue` | Node.js `EventEmitter` or `async-queue` | Event-driven, similar semantics |
| `asyncio.Lock` | `async-mutex` npm package | Same purpose |
| `asyncio.Event` | Node.js `EventEmitter` event | Signal pattern |
| `asyncio.create_task` | fire-and-forget async IIFE: `(async () => { while (!shutdown) { ... } })()` | `setImmediate` is **wrong** — it defers one tick, not a loop; this would break all three background loops |
| `asyncio.gather` | `Promise.all` / `Promise.allSettled` | Direct equivalent |
| `collections.deque` | Custom circular array or `denque` npm | Buffer backing store |
| `threading.RLock` | Not needed (Node.js single-threaded) | Simplification |
| `psutil` | `pidusage` npm package | CPU/memory per-PID |


**Layer 2: Business logic**


| Python | TypeScript equivalent | Complexity |
|---|---|---|
| `pydantic.BaseModel` | `zod.object` | Low - schema-for-schema port |
| `fnmatch.fnmatch` | `minimatch` or manual glob | Low |
| `PIL.Image` | `sharp` npm package | Medium - different API |
| `re.compile(pattern)` | `new RegExp(pattern, flags)` | Low |
| `pathlib.Path` | `node:path` + `node:fs/promises` | Low |
| `logging` module | `pino` or `winston` | Low |


**Layer 3: MCP server**


```python
# Python: fastmcp decorator pattern
@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, ...))
async def interactive_openroad_query(command: str, session_id: str | None = None) -> str:
   ...
```


```typescript
// TypeScript: SDK register pattern
server.tool(
 'interactive_openroad_query',
 { command: z.string(), session_id: z.string().optional() },
 async ({ command, session_id }) => ({
   content: [{ type: 'text', text: await queryShellTool.execute(command, session_id) }]
 })
);
```


The MCP TypeScript SDK boilerplate is comparable in size to fastmcp. The main difference is that tool annotations (`readOnlyHint`, `destructiveHint`, etc.) require careful verification against the TypeScript SDK's current API surface.


**Layer 4: Tests**


Each Python test module maps to a Vitest module. The mocking patterns are equivalent:


```python
# Python
with patch("openroad_mcp.interactive.pty_handler.pty.openpty") as mock:
   mock.return_value = (10, 11)
   ...
```


```typescript
// TypeScript (Vitest)
vi.mock('node-pty', () => ({ spawn: vi.fn().mockReturnValue(mockPtyProcess) }));
```

The biggest risk isn't the code volume it's PTY behavioral differences with OpenROAD's specific Tcl REPL. Build and test the PTY layer first. If it doesn't work cleanly at the first stage, we'll know before committing to the full timeline.

---

## Section 3: Stage-Gated Timeline for Full Rewrite


It is intentionally **stage-gated**: do not commit to Weeks 2-3 until the Week 1 PTY gate passes.


### Week 1: PTY Spike + Core Scaffolding (Days 1–5, Go/No-Go Gate)


**Day 1–2: Project scaffolding**
- `package.json`, `tsconfig.json` (strict mode), `eslint.config.ts`, `vitest.config.ts`
- Source layout mirroring current Python structure: `src/pty/`, `src/session/`, `src/tools/`, etc.
- CI skeleton: `actions/setup-node@v4`, lint + typecheck jobs
- Port `constants.ts`, `exceptions.ts`, `path_security.ts` (pure logic, ~3h each)


**Day 3: PTY handler**
- Implement `PtyHandler` class wrapping `node-pty`
- Map `PTYHandler.create_session()` -> `pty.spawn()` with same env vars (`TERM`, `COLUMNS`, `LINES`)
- Map `PTYHandler.write_input()` -> `ptyProcess.write()`
- Map `PTYHandler.read_output()` -> event-driven via `ptyProcess.onData()`
- **Critical difference:** `node-pty` is event-driven (push), Python reads on demand (pull). The Node.js implementation should buffer incoming data in the circular buffer via `onData` callback, removing the explicit reader background task.
- Unit tests for PTY handler using mocked `node-pty` process


**Day 4: Circular buffer and session**
- `CircularBuffer` class: Node.js `Buffer` arrays with byte accounting, EventEmitter for data-available signaling
- `InteractiveSession` class: replaces asyncio tasks with `node-pty` event handlers + `async/await` orchestration
- `send_command()`: write to PTY process
- `read_output()`: Promise that resolves after completion-window silence detection (same 100ms window as Python)


**Day 5: OpenROAD manager and session lifecycle**
- `OpenROADManager` singleton: `create_session`, `execute_command`, `terminate_session`, `cleanup_idle_sessions`
- ANSI decoder port: `strip-ansi` + `ansi-regex` packages handle the heavy lifting; port `clean_openroad_output()` as a 10-line function
- Error patterns: hardcode 17 patterns as a TypeScript `const` array — patterns are defined inline in `session.py` lines 35–53 and must be ported as inline TypeScript constants, not loaded from a file


**End-of-Week 1 Gate (mandatory):**
- Run real OpenROAD REPL checks (`version`, `help`, representative query/exec commands), not only mocked PTY tests.
- Validate completion detection parity (100ms silence window) across repeated command runs.
- Validate output correctness (prompt stripping, ANSI cleanup, no truncation on larger outputs).
- Validate lifecycle behavior (create/execute/terminate/recover) with deterministic outcomes.

**Go decision:** proceed to Week 2 only if the PTY spike is stable and reproducible in CI/devcontainer.

### Week 2: Business Logic, Tools, and Server (Days 6–10)


**Day 6: Settings and command whitelist**
- `Settings` class from env vars: direct port, all 12 settings + `from_env()` factory
- Command whitelist: port `BLOCKED_COMMANDS`, `EXEC_ONLY_PATTERNS`, `READONLY_PATTERNS` as TypeScript `Set`/`readonly string[]`
- `is_query_command()` and `is_exec_command()`: replace `fnmatch` with `minimatch` for glob pattern matching
- Unit tests: the whitelist has 100+ test cases in Python - all must pass


**Day 7–8: Zod schemas (replacing Pydantic models)**


This is mechanical but requires care. Each Pydantic model becomes a Zod schema with an inferred TypeScript type:


```typescript
// Replaces InteractiveExecResult Pydantic model
const InteractiveExecResult = z.object({
 output: z.string(),
 session_id: z.string().nullable(),
 timestamp: z.string(),
 execution_time: z.number(),
 command_count: z.number().default(0),
 buffer_size: z.number().default(0),
 error: z.string().nullable().optional(),
});
type InteractiveExecResult = z.infer<typeof InteractiveExecResult>;
```


14 Pydantic models -> 14 Zod schemas. The serialization to JSON stays identical because Zod's `z.object().parse()` produces the same structure.


**Day 8–9: Report images tool**


The `report_images.py` uses PIL for image compression. The TypeScript port uses `sharp`:


```typescript
// Python: PIL.Image.open() + thumbnail() + save()
// TypeScript: sharp().resize().webp({ quality: 85 }).toBuffer()
```


The path validation (`validate_path_segment`, `validate_safe_path_containment`) ports directly. The 15KB base64 threshold and WEBP compression strategy stay identical.


**Day 9–10: MCP server and all 10 tools**


- Port `BaseTool._format_result()` -> TypeScript generic formatting function
- Port all 8 interactive tools from `tools/interactive.py`
- Port 2 report image tools
- Wire up `McpServer` with `StdioServerTransport` (and optionally `StreamableHTTPServerTransport` for HTTP mode)
- CLI: `commander` npm package replaces `argparse` for `--transport`, `--host`, `--port` flags
- Signal handling: `process.on('SIGTERM', cleanup)` replaces `cleanup_manager.setup_signal_handlers()`


### Week 3: Tests, CI, Packaging, and Documentation (Days 11–15)


**Day 11–12: Unit tests**


Priority order for test rewriting:
1. `test_command_whitelist.py` - pure logic, highest ROI, ~200 tests
2. `test_interactive_pty.py` - PTY handler mocking with Vitest
3. `test_interactive_session.py` - session lifecycle
4. `test_session_manager.py` - manager unit tests
5. `test_interactive_tools.py` - tool layer
6. `test_report_images.py` - image tools
7. `test_interactive_buffer.py` - circular buffer


**Day 13: Integration and performance tests**


- Port `test_pty_integration.py` - runs real `bash` or `cat` processes to verify PTY behavior
- Port performance benchmarks: latency, memory, response sizes
- These are the most important tests because they catch the subtle behavioral differences between `node-pty` and Python's `pty`


**Day 14: CI, Docker, and packaging**


CI changes:
```yaml
# Replace this Python CI setup:
- uses: astral-sh/setup-uv@v6
- run: make sync


# With this:
- uses: actions/setup-node@v4
 with: { node-version: '22' }
- run: npm ci
```


Docker changes:
```dockerfile
# Builder stage: need node-gyp deps for node-pty native compilation
FROM openroad/orfs:${ORFS_VERSION} AS builder
RUN apt-get install -y python3 make g++  # node-gyp requires these
RUN npm ci --prefix /app


# Runtime stage: only /app/node_modules needed
FROM openroad/orfs:${ORFS_VERSION} AS runtime
COPY --from=builder /app/node_modules /app/node_modules
COPY dist/ /app/dist/
```


> **Note:** `node-pty` requires a C++ compiler and Python during `npm install` (for `node-gyp`). This is an irony of the migration - you still need Python in the Docker builder stage, just not at runtime.


`package.json` for npm distribution:
```json
{
 "name": "openroad-mcp",
 "version": "0.5.0",
 "bin": { "openroad-mcp": "./dist/main.js" },
 "files": ["dist/"],
 "engines": { "node": ">=22" }
}
```


`npx` invocation (replaces `uvx`):
```json
{
 "mcpServers": {
   "openroad-mcp": {
     "command": "npx",
     "args": ["-y", "openroad-mcp"]
   }
 }
}
```


**Day 15: Documentation, release**
- Update README with `npx` instructions
- Update QUICKSTART with Node.js 22 requirement
- Publish `0.5.0-beta.1` to npm for testing
- Keep Python package maintained during transition period (minimum 60 days)


---


## Section 4: Schema Contract


The JSON schemas exposed over MCP must be identical between Python and TypeScript implementations. This section documents the exact contract that cannot change.


### Tool Input Schemas (what the AI client sends)


```
interactive_openroad_query(command: string, session_id?: string, timeout_ms?: integer)
interactive_openroad_exec(command: string, session_id?: string, timeout_ms?: integer)
create_interactive_session(session_id?: string, command?: string[], env?: object, cwd?: string)
list_interactive_sessions()
terminate_interactive_session(session_id: string, force?: boolean)
inspect_interactive_session(session_id: string)
get_session_history(session_id: string, limit?: integer, search?: string)
get_session_metrics()
list_report_images(platform: string, design: string, run_slug: string, stage?: string)
read_report_image(platform: string, design: string, run_slug: string, image_name: string)
```


### Tool Output Schemas (JSON strings returned by all tools)


All tools return JSON strings with a consistent `error: string | null` field. The Python Pydantic models and TypeScript Zod schemas must serialize identically. Critical fields:


```typescript
// InteractiveExecResult - returned by both query and exec tools
{
 output: string,         // Cleaned OpenROAD output (ANSI stripped)
 session_id: string | null,
 timestamp: string,      // ISO 8601
 execution_time: number, // seconds, float
 command_count: number,
 buffer_size: number,    // bytes
 error: string | null
}


// InteractiveSessionInfo - returned by create/list/inspect tools
{
 session_id: string,
 created_at: string,     // ISO 8601
 is_alive: boolean,
 command_count: number,
 buffer_size: number,
 uptime_seconds: number | null,
 state: "creating" | "active" | "terminated" | "error" | null,
 error: string | null
}
```


> **Schema migration risk:** TypeScript's `null` vs `undefined` handling differs from Python's `None`. Zod's `.nullable()` vs `.optional()` vs `.nullish()` must be applied carefully. Run the existing Python test suite against a golden-file snapshot before starting the TypeScript port, then use the same snapshot to validate TypeScript output.


### Tool Annotations


These affect how AI clients interpret tool behavior. They must be preserved exactly:


| Tool | readOnly | destructive | idempotent |
|---|---|---|---|
| `interactive_openroad_query` | ✓ | ✗ | ✗ |
| `interactive_openroad_exec` | ✗ | ✓ | ✗ |
| `list_interactive_sessions` | ✓ | ✗ | ✓ |
| `create_interactive_session` | ✗ | ✗ | ✗ |
| `terminate_interactive_session` | ✗ | ✓ | ✓ |
| `inspect_interactive_session` | ✓ | ✗ | ✓ |
| `get_session_history` | ✓ | ✗ | ✓ |
| `get_session_metrics` | ✓ | ✗ | ✓ |
| `list_report_images` | ✓ | ✗ | ✓ |
| `read_report_image` | ✓ | ✗ | ✓ |


---


## Section 5: Packaging


### Current (Python/uvx)


```
Distribution channel: PyPI (openroad-mcp) + GitHub direct
Install command: uvx openroad-mcp
Direct install: uvx --from git+https://github.com/luarss/openroad-mcp openroad-mcp
Local dev: uv run openroad-mcp
Runtime deps: Python 3.13+, uv
```


The `uv.lock` file (254KB) pins 47 transitive dependencies. Startup time with `uvx`: 2–5 seconds on first run (downloads + installs), <1 second after cache.


### Target (TypeScript/npx)


```
Distribution channel: npm (openroad-mcp)
Install command: npx -y openroad-mcp
Direct install: npx -y openroad-mcp@latest
Local dev: npm run dev
Runtime deps: Node.js 22+
```


**Dependency inventory for `package.json`:**


| npm package | replaces | native module? |
|---|---|---|
| `@modelcontextprotocol/sdk` | `fastmcp` + `mcp[cli]` | No |
| `node-pty` | `pty` + `termios` + `fcntl` | **Yes** (node-gyp) |
| `zod` | `pydantic` | No |
| `sharp` | `pillow` | **Yes** (libvips) |
| `pidusage` | `psutil` | No |
| `minimatch` | `fnmatch` | No |
| `commander` | `argparse` | No |
| `pino` | `logging` | No |
| `strip-ansi` | `ANSIDecoder.translate_output` | No |


Two packages (`node-pty` and `sharp`) require native compilation. This is the most important packaging concern. In practice:
- `node-pty` publishes prebuilt binaries for common platforms (Linux x64, macOS arm64/x64, Windows x64) via `node-pre-gyp`. Most users will get a binary download, not a compilation.
- `sharp` similarly publishes prebuilt `libvips` binaries. Installation is usually fast.
- The Docker build will always compile from source because `openroad/orfs` is an unusual base image that won't have prebuilt matches.


**npm publish workflow** (replaces PyPI release.yml):
```yaml
- run: npm run build       # tsc --project tsconfig.json
- run: npm run test        # vitest run
- run: npm publish --access public
```


**`npx` startup time:** `npx -y` downloads and caches the npm package. First-run: 3–8 seconds (npm download). Subsequent runs: <1 second (uses npm cache). Comparable to `uvx`.


**`server.json` for MCP registry** will need updating to reflect npm package metadata and runtime hints.  
Publishing remains automated via the existing release workflow (`mcp-publisher` with GitHub OIDC); no separate manual maintainer handoff should be required in the normal path.


---



## Section 6: Testing Strategy


### Current Coverage


The Python test suite has 5 categories with 40+ test files and 5,243+ lines:


| Category | What it tests | Migration priority |
|---|---|---|
| `tests/interactive/` | PTY handler, session, buffer, manager | **Critical** - PTY semantics must match |
| `tests/tools/` | All 10 MCP tools including whitelist | **Critical** - tool output must be identical |
| `tests/integration/` | Real PTY processes (bash/cat) | **Critical** - validates node-pty vs Python pty |
| `tests/cli/` | CLI argument parsing | Medium |
| `tests/performance/` | Latency, memory, response sizes | Medium |


### Golden-File Testing Strategy


Before starting the TypeScript port, run the Python server against a fixed set of inputs and save the JSON responses as golden files. The TypeScript implementation passes QA when all golden files match byte-for-byte (modulo timestamps):


```
tests/golden/
 interactive_exec_result.json
 session_list_result.json
 session_metrics_result.json
 report_image_list_result.json
 ...
```


This is the single most valuable testing investment for this migration. It catches schema drift that unit tests miss.


### PTY Integration Tests - Highest Risk


The integration tests that spawn real subprocesses (e.g., `bash -c 'echo hello'`) are the most valuable because they validate that `node-pty` produces the same terminal behavior as Python's `pty`. Known behavioral differences to test for:


1. **Terminal prompt detection:** Python's implementation polls with `MAX_COMMAND_COMPLETION_WINDOW = 100ms` silence. `node-pty`'s event-driven model should behave the same, but validate with timing tests.
2. **ANSI escape stripping:** The `ANSIDecoder.clean_openroad_output()` method removes `openroad> ` prompt artifacts. Verify this works with `node-pty`'s output.
3. **Large output handling:** The 128KB circular buffer with eviction. Verify the buffer threshold behavior matches under load.
4. **Session state on process death:** Python detects `EIO` errno (errno 5) on `os.read()`. `node-pty` fires `onExit`. Verify `is_alive()` returns `false` in both cases within the same timeout window.


### Vitest Configuration


```typescript
// vitest.config.ts
export default {
 test: {
   globals: true,
   environment: 'node',
   coverage: { provider: 'v8', threshold: { lines: 80 } },
   // PTY integration tests require real file descriptors
   pool: 'forks',  // Required for node-pty tests (can't share FDs across workers)
 }
};
```


> **Warning:** `node-pty` tests cannot run in Vitest's default `threads` pool because PTY file descriptors cannot be shared across worker threads. Use `pool: 'forks'`. This is the same reason the Python PTY tests are separated (`make test-interactive` vs `make test`).


### Linting and Type Checking (replacing ruff + mypy)


```
eslint (with @typescript-eslint) -> replaces ruff
tsc --noEmit (strict mode)       -> replaces mypy strict
```


The Python `mypy` config is strict (disallows untyped defs, checks return types, etc.). The TypeScript `tsconfig.json` should be equally strict:


```json
{
 "compilerOptions": {
   "strict": true,
   "noUncheckedIndexedAccess": true,
   "exactOptionalPropertyTypes": true,
   "noImplicitOverride": true
 }
}
```


---


## Section 7: Risks and Mitigations


### Risk 1: `node-pty` behavioral differences (HIGH)
**What:** OpenROAD is a complex interactive Tcl application. Subtle terminal behavior differences (timing, echo, signal delivery) could cause the command completion detection to fail or miss output. 
**Mitigation:** Integration tests with a real OpenROAD binary running simple commands (`version`, `help`, `puts hello`). Run these in CI on the same `openroad/orfs` Docker image. Set a hard gate: TypeScript must pass all integration tests before merging.


### Risk 2: node-pty native compilation failures (MEDIUM)
**What:** `node-pty` may fail to compile on unusual Linux distributions or Alpine-based images. 
**Mitigation:** Pin `node-pty` to a release with known prebuilt binaries. Test Docker build in CI before shipping. Provide a `RUN apt-get install -y python3 make g++` layer in the Dockerfile builder stage.


### Risk 3: Schema divergence causing AI client failures (HIGH)
**What:** If the JSON output format changes (field names, null vs undefined, number precision), AI clients that have learned to parse the Python server's output will break. 
**Mitigation:** Golden-file tests as described above. Run the existing integration tests against the TypeScript server with a real MCP client (Claude Code) before release. Keep the Python `v0.4.x` branch alive and published for 60 days after TypeScript release.


### Risk 4: Timeline underestimate (MEDIUM)
**What:** The PTY layer is the most uncertain piece. If `node-pty` behaves unexpectedly with OpenROAD's specific Tcl REPL, debugging could consume a full week. 
**Mitigation:** Build and test the PTY layer (Days 3–4) first. If real OpenROAD integration is not passing by Day 5, re-evaluate the timeline before committing to the full rewrite.


### Risk 5: Roadmap opportunity cost (MEDIUM)
**What:** The current roadmap has real features planned for v0.5 (session persistence, e2e testing) and v0.8 (multi-client support, MCP registry). A 3-week rewrite pauses all feature work. 
**Mitigation:** This is a business decision. If distribution friction is the #1 pain point from user feedback, the rewrite is worth it. If users are requesting features, delay the migration.


---


## Section 8: Recommendation


### The Decision Matrix


| Criterion | Weight | Stay Python | Migrate TypeScript |
|---|---|---|---|
| User install friction | High | `uvx` requires Python 3.13 + uv (not universal) | `npx` requires Node.js 22+ (common in modern MCP environments; current Node is 24) |
| Ecosystem discoverability | Medium | Less common for MCP | Default for MCP registry/tutorials |
| Implementation risk | High | None (code works today) | PTY behavioral differences |
| Roadmap impact | High | 3 weeks of feature development | 3 weeks of migration work |
| Long-term maintenance | Medium | Strong Python ecosystem for EDA users | Strong TS ecosystem for MCP ecosystem |

The project is at v0.4.2, pre-release, with an unstabilized API. This is the lowest-cost moment to evaluate migration risk, but the dominant uncertainty is PTY/OpenROAD behavior parity. Treat Week 1 as a formal feasibility checkpoint: if PTY parity is solid, continue; if not, avoid sunk-cost escalation and switch tracks.


---


## Appendix: Quick-Reference Mapping


### Python asyncio -> Node.js equivalents


| Python | Node.js |
|---|---|
| `asyncio.create_task(coro())` | fire-and-forget async IIFE: `(async () => { while (!shutdown) { ... } })()` |
| `asyncio.gather(*coros)` | `Promise.all([...promises])` |
| `asyncio.wait_for(coro, timeout)` | `Promise.race([coro, timeoutPromise])` |
| `asyncio.Queue(maxsize=N)` | `EventEmitter` or custom bounded queue |
| `asyncio.Lock()` | `new Mutex()` from `async-mutex` |
| `asyncio.Event()` | `EventEmitter` + custom `waitFor()` helper |
| `asyncio.sleep(n)` | `await new Promise(r => setTimeout(r, n * 1000))` |


### File-by-file rewrite priority order


1. `constants.py` (Day 1, ~1h)
2. `exceptions.py` (Day 1, ~1h)
3. `path_security.py` (Day 1, ~2h)
4. `settings.py` (Day 1, ~3h)
5. `ansi_decoder.py` (Day 1, ~2h)
6. `pty_handler.py` (Day 3, ~8h) <- **highest risk**
7. `buffer.py` (Day 4, ~4h)
8. `interactive/models.py` (Day 4, ~2h)
9. `session.py` (Day 4–5, ~12h) <- **most lines**
10. `core/models.py` (Day 5, ~4h)
11. `manager.py` (Day 5, ~6h)
12. `command_whitelist.py` (Day 6, ~4h)
13. `tools/base.py` (Day 7, ~2h)
14. `tools/interactive.py` (Day 7–8, ~8h)
15. `tools/report_images.py` (Day 8–9, ~8h)
16. `server.py` (Day 9, ~4h)
17. `config/cli.py` (Day 10, ~3h)
18. `main.py` (Day 10, ~2h)
19. `utils/cleanup.py` (Day 10, ~2h)




