# OpenROAD MCP — Security Model

This document describes the security boundaries, access controls, and known exposure risks of the OpenROAD MCP server. It covers the Tcl command whitelist, the PTY spawn allowlist, every environment variable that affects security-relevant behaviour, path containment for report images, and the HTTP transport's exposure surface.

---

## Contents

- [Tcl Command Whitelist](#tcl-command-whitelist)
  - [Three-tier Design](#three-tier-design)
  - [Query versus Exec Enforcement](#query-versus-exec-enforcement)
  - [Compound Statements and Bracket Substitution](#compound-statements-and-bracket-substitution)
  - [Disabling the Whitelist](#disabling-the-whitelist)
- [PTY Spawn Allowlist](#pty-spawn-allowlist)
- [Environment Variable Reference](#environment-variable-reference)
- [Report Image Path Containment](#report-image-path-containment)
- [HTTP Transport Exposure](#http-transport-exposure)
- [Exec is Not a Sandbox](#exec-is-not-a-sandbox)

---

## Tcl Command Whitelist

The whitelist is implemented in
[`typescript/src/config/command_whitelist.ts`](../typescript/src/config/command_whitelist.ts). It
guards **Tcl statements** sent to the OpenROAD REPL, not the shell binary (that is the PTY spawn
allowlist below).

### Three-tier Design

**Tier 1 — `BLOCKED_COMMANDS` (denied in both tools)**

These are OS-level Tcl built-ins that can escape the EDA context regardless of OpenROAD's
own access controls.

| Command | Reason Blocked |
|---------|----------------|
| `quit` | terminates the OpenROAD process |
| `socket` | opens arbitrary network connections |
| `load` | loads compiled C extensions into the interpreter |
| `glob` | enumerates the filesystem |
| `fconfigure` | configures I/O channels |
| `chan` | channel operations |
| `vwait` | blocks the event loop indefinitely |
| `rename` | renames or deletes commands, bypassing top-level checks |
| `after` | schedules arbitrary code execution |
| `subst` | performs substitutions that can invoke arbitrary commands |

**Tier 2 — `EXEC_ONLY_PATTERNS` (denied in query, allowed in exec)**

These are explicitly state-modifying or file-system-touching commands. They are allowed in
`interactive_openroad_exec` and rejected in `interactive_openroad_query`.

Exact verbs: `exec`, `source`, `exit`, `open`, `close`, `file`, `cd`, `uplevel`

Wildcard patterns: `set_*`, `create_*`, `read_*`, `write_*`

Named flow commands: `initialize_floorplan`, `place_pins`, `global_placement`,
`detailed_placement`, `clock_tree_synthesis`, `global_route`, `detailed_route`,
`repair_design`, `repair_timing`, `repair_clock_nets`, `log_begin`, `log_end`

**Tier 3 — `READONLY_PATTERNS` (allowed in both tools)**

Wildcard patterns: `report_*`, `get_*`, `check_*`

Named commands: `estimate_parasitics`, `sta`, `help`, `version`

Safe Tcl built-ins: `puts`, `set`, `expr`, `return`, `break`, `continue`, `list`, `llength`,
`lindex`, `lappend`, `lrange`, `lsort`, `lsearch`, `lreplace`, `string`, `regexp`, `regsub`,
`format`, `scan`, `array`, `dict`, `error`, `upvar`, `global`, `variable`, `concat`, `join`,
`split`, `incr`, `append`, `info`, `unset`

**Unknown commands** are treated as exec-only: denied in query, allowed in exec. They will fail at
the Tcl level inside OpenROAD if they are not valid commands.

### Query versus Exec Enforcement

| Context | `interactive_openroad_query` | `interactive_openroad_exec` |
|---------|------------------------------|-----------------------------|
| **Default policy** | **deny** (only READONLY_PATTERNS pass) | **allow** (only BLOCKED_COMMANDS fail) |
| **Exec-only verbs** | rejected | allowed |
| **Unknown verbs** | rejected (treated as exec-only) | allowed |
| **Blocked verbs** | rejected | rejected |

When a command is rejected the tool returns a JSON response — no exception is thrown to the
client:

```json
{
  "output": "",
  "session_id": "sess-0001",
  "timestamp": "...",
  "execution_time": 0,
  "command_count": 0,
  "buffer_size": 0,
  "error": "CommandBlocked: 'exit'",
  "message": "Command blocked: 'exit' is not on the OpenROAD allowlist.\nFull command: 'exit'"
}
```

### Compound Statements and Bracket Substitution

The whitelist parses multi-statement input before checking:

- **Statement splitting** respects `"` quotes, `{}`  braces, and backslash escapes. It splits on
  `;`, `\n`, and a range of Unicode line separators.
- **Bracket substitution** (`[command ...]`) is scanned recursively — `set x [exec ls]` extracts
  verb `exec` from the inner command.
- **Body-eval builtins** (`if`, `for`, `foreach`, `while`, `proc`, `catch`, `namespace`) are not
  in `_TCL_BUILTINS`, so they reach the default "unknown → exec-only" path and are rejected in
  query.
- **`eval`** is not in `BLOCKED_COMMANDS`, so it is allowed in exec. In query it is rejected as
  unknown.
- **Backslash obfuscation** is neutralised: `tclUnescape()` normalises `\socket`, `\x73ocket`,
  and octal escapes before matching.
- **Comments** (lines starting with `#` and blank lines, including any brackets inside them) are
  skipped entirely.

### Disabling the Whitelist

Set `OPENROAD_WHITELIST_ENABLED=false` to skip all Tcl checks. Intended for trusted development
environments where the full ORFS Tcl API is needed without restriction. Never expose an
unwhitelisted server over HTTP without additional access controls.

---

## PTY Spawn Allowlist

A separate layer in
[`typescript/src/interactive/pty_handler.ts`](../typescript/src/interactive/pty_handler.ts)
guards the **shell binary and arguments** at session creation, independently of the Tcl whitelist.

When `OPENROAD_ENABLE_COMMAND_VALIDATION=true` (default):

- The executable name must be in `OPENROAD_ALLOWED_COMMANDS` (default: `["openroad"]`).
- No argument may contain shell metacharacters (`;`, `&`, `|`, `` ` ``, `$`, `\n`, `\r`).
- No argument may contain path traversal (`..`).
- No argument may contain redirection operators (`>`, `<`).

To allow additional executables (e.g. `sta`):

```bash
OPENROAD_ALLOWED_COMMANDS=openroad,sta
```

Set `OPENROAD_ENABLE_COMMAND_VALIDATION=false` to skip spawn validation entirely.

---

## Environment Variable Reference

All variables are read at startup by [`typescript/src/config/settings.ts`](../typescript/src/config/settings.ts).

| Variable | Type | Default | What it gates |
|----------|------|---------|---------------|
| `OPENROAD_COMMAND_TIMEOUT` | float (seconds) | `30.0` | Per-command timeout; override per-call with `timeout_ms` |
| `OPENROAD_COMMAND_COMPLETION_DELAY` | float (seconds) | `0.1` | Delay before declaring command completion. |
| `OPENROAD_DEFAULT_BUFFER_SIZE` | integer (bytes) | `131072` (128 KiB) | Circular output buffer max size per session |
| `OPENROAD_MAX_SESSIONS` | integer | `50` | Maximum concurrent active sessions |
| `OPENROAD_SESSION_QUEUE_SIZE` | integer | `128` | Maximum pending commands in input queue |
| `OPENROAD_SESSION_IDLE_TIMEOUT` | float (seconds) | `300.0` | Idle threshold; does **not** trigger automatic cleanup (see [Session Lifecycle Notes](API.md#session-lifecycle-notes)) |
| `OPENROAD_READ_CHUNK_SIZE` | integer (bytes) | `8192` | Max chunk size when splitting large PTY bursts |
| `OPENROAD_IMAGE_MAX_BASE64_KB` | integer (KB) | `1024` | Report-image payload budget; override per-call with `max_size_kb` |
| `OPENROAD_IMAGE_MAX_DIMENSION` | integer (pixels) | `1568` | Longest edge an image is capped to before encoding |
| `OPENROAD_IMAGE_MIN_DIMENSION` | integer (pixels) | `512` | Floor below which the resize ladder will not shrink |
| `OPENROAD_OUTPUT_HISTORY_CHARS` | integer (chars) | `262144` (256 KB) | Recent command output retained per session for `grep_session_output`; `0` disables |
| `OPENROAD_OUTPUT_HISTORY_COMMANDS` | integer | `50` | Commands of output retained per session; `0` disables |
| `OPENROAD_MAX_FLOW_JOBS` | integer | `2` | Concurrent `run_orfs_stage` runs allowed |
| `OPENROAD_FLOW_RUN_TIMEOUT` | float (seconds) | `21600` (6 h) | Default wall-clock budget for a flow run |
| `OPENROAD_RUN_LOG_DIR` | path | `<tmpdir>/openroad-mcp-runs` | Where flow-run logs are streamed |
| `OPENROAD_ALLOWED_COMMANDS` | string (comma-separated) | `openroad` | PTY spawn executable allowlist |
| `OPENROAD_ENABLE_COMMAND_VALIDATION` | bool | `true` | Enables/disables `PtyHandler.validateCommand` |
| `OPENROAD_WHITELIST_ENABLED` | bool | `true` | Enables/disables the Tcl command whitelist |
| `ORFS_FLOW_PATH` | path | `~/OpenROAD-flow-scripts/flow` (auto-detected if unset) | Root for ORFS reports; tilde-expanded at runtime |
| `LOG_LEVEL` | string | `INFO` | Root pino logger level (`DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL`) |
| `LOG_FORMAT` | string | (N/A) | Unused; logging uses pino with a fixed JSON format |

CLI flags `--verbose` and `--log-level` override `LOG_LEVEL` after the settings are initialised.
No other CLI flag overrides a Settings field.

`PATH` is not a Settings field. At startup the server inherits the client's `PATH`, then (only if `openroad` is not already found) merges the login-shell `PATH` and common install locations. An explicit `PATH` in the MCP client `env` block still wins when it already contains `openroad`.

---

## Report Image Path Containment

Report images are served from:

```
{ORFS_FLOW_PATH}/reports/{platform}/{design}/{run_slug}/
```

The containment enforcement in
[`typescript/src/utils/path_security.ts`](../typescript/src/utils/path_security.ts) works in
two layers:

**Layer 1 — Segment Validation** (applied to `run_slug` and `image_name` independently):

- Empty or whitespace-only value → rejected
- `.` or `..` → rejected
- Contains `/` or `\` → rejected
- Contains null byte `\x00` → rejected
- Contains glob characters `* ? [ ]` → rejected

**Layer 2 — Realpath Containment** (applied after joining paths):

The resolved real path (via `realpathSync`, with a walk-up for non-existent suffixes) must be
under the base directory. A symlink that points outside the base is caught here.

**Additional constraints:**

- Only report-image extensions are served — `.webp`, `.png`, and the doubled `.webp.png` form
  some ORFS builds emit. The listing skips everything else and `read_report_image` rejects any
  `image_name` that does not end in one of them.
- Symlinks are skipped during directory listing.
- On-disk file size is capped at 50 MB before any decoding.
- The base64 payload is budgeted at `OPENROAD_IMAGE_MAX_BASE64_KB` (default 1024 KB), which a
  caller may override per-call with `max_size_kb`. An image over budget is downscaled with sharp
  (lanczos3, WebP quality 85 → 70 → 55) along a ladder bounded by `OPENROAD_IMAGE_MAX_DIMENSION`
  (default 1568 px) above and `OPENROAD_IMAGE_MIN_DIMENSION` (default 512 px) below, and at most
  12 encode attempts. A caller raising `max_size_kb` raises the payload this server will emit;
  the 50 MB on-disk cap above still bounds what is read.

### Flow-run execution policy

`run_orfs_stage` spawns `make`, which `OPENROAD_ALLOWED_COMMANDS` does not cover — that setting
gates the `openroad` binary for PTY sessions only. The flow runner therefore carries its own policy.

**Target allowlist.** Only `synth`, `floorplan`, `place`, `cts`, `grt`, `route`, `finish`, `all`,
`metadata` and the `clean_*` forms are accepted. This is not cosmetic: without it a `stage` value
of `-f/tmp/evil.mk` reaches make as a *flag* rather than a goal, redirecting it to an attacker's
makefile.

**Override validation.** Keys must match `^[A-Z_][A-Z0-9_]*$`. These are refused regardless of
value, because they control how make executes every recipe rather than what it builds:

`SHELL`, `MAKESHELL`, `.SHELLFLAGS`, `MAKE`, `MAKEFLAGS`, `MAKEFILES`, `PATH`, `LD_PRELOAD`,
`LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`.

Values are rejected if they contain newlines or null bytes (which would forge additional make
arguments), or `$(`, `${` or a backtick. The last matters even though no shell is involved: **make
expands `$(...)` when it reads a variable value**, so `FOO=$(shell id)` is a live execution path.

**No shell.** The child is spawned with an argv array and `shell: false`, so an override value is
one argument and is never re-parsed.

**Process group.** Runs are spawned detached, into their own process group, so `cancel_orfs_job`,
the timeout, and server shutdown can signal the whole tree. Killing only `make` would leave the
`openroad` it spawned running — orphaned OpenROAD processes have been observed on this deployment.

**Resource governance.** `OPENROAD_MAX_FLOW_JOBS` (default 2) caps concurrent runs, and
`OPENROAD_FLOW_RUN_TIMEOUT` (default 6 h) bounds each one. A flow run is far heavier than an
interactive session.

**Still privileged.** `run_orfs_stage` writes into the ORFS flow tree and the `clean_*` targets
delete results; it is annotated `destructiveHint: true`. The policy above constrains *what make is
told to build*, not what the design's own configuration causes it to run.

### `read_orfs_metrics` path handling

`read_orfs_metrics` reads only one location under the ORFS flow root — the stage metrics and logs
in `logs/<platform>/<design>/<variant>/`. It writes nothing and executes nothing.

- `design` and `variant` are validated as single path segments (`validatePathSegment`), so
  separators, `..`, null bytes and glob characters are rejected.
- The resolved logs directory is checked with `validateSafePathContainment` against
  `<flow>/logs`, which resolves symlinks in existing parents, so a symlinked run directory cannot
  escape the flow tree.
- `platform` is not free-form: it is either inferred from the design or checked against the
  platforms ORFS actually has.
- Every path in the response is relative to the flow root, so absolute host paths are not disclosed.
- Stage logs are returned filtered to ORFS's own `[ERROR ...]` / `[WARNING ...]` lines, capped at
  50 per category per stage, rather than as raw log contents.

**Known image filename mappings:**

Images are classified by filename stem: the `stage` is the prefix before the first `_`, and the
`type` is looked up in a fixed mapping. Filenames not in the mapping get `type: "unknown"`.
Recognised stems: `cts_clk`, `cts_clk_layout`, `cts_core_clock`, `cts_core_clock_layout`,
`final_all`, `final_clocks`, `final_congestion`, `final_ir_drop`, `final_placement`,
`final_resizer`, `final_routing`.

---

## HTTP Transport Exposure

Start the server with `--transport http` (default `localhost:8000`) to expose it over Streamable
HTTP instead of stdio.

**There is no authentication, no CORS policy, and no DNS-rebinding protection in the application
code.** Any process that can reach `localhost:8000` can call any tool.

Practical guidance:

- Use HTTP mode only in trusted, isolated networks (local development, a private cluster with
  network policies).
- Add a reverse proxy with authentication (e.g. nginx + mTLS, Tailscale) if you need to expose
  the endpoint beyond localhost.
- The server creates a fresh MCP instance per request; session continuity is maintained via
  explicit `session_id` params, not HTTP session cookies.
- The request body is capped at 1 MB (`MAX_BODY_BYTES`); oversized requests are rejected with
  HTTP 400.

---

## Exec is Not a Sandbox

The whitelist is a guardrail against accidental misuse by AI agents, **not a security sandbox**.
It prevents the most obvious footguns (`quit`, network, `eval`-style injection) but it does not:

- Prevent OpenROAD from reading or writing files through its own C++ API.
- Prevent `exec` (allowed in exec tool) from spawning additional processes.
- Isolate the OpenROAD process from the host filesystem.
- Protect against a compromised or malicious `openroad` binary.

For a hardened deployment, run the server and OpenROAD inside a container with a restricted
filesystem mount and no network access beyond what ORFS requires.
