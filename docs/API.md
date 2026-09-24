# OpenROAD MCP — API Reference

This document is the authoritative reference for the MCP tools exposed by the TypeScript server.
It is generated from the source of truth: [`typescript/src/server.ts`](../typescript/src/server.ts),
[`typescript/src/config/command_whitelist.ts`](../typescript/src/config/command_whitelist.ts),
[`typescript/src/core/models.ts`](../typescript/src/core/models.ts), and the golden fixtures under
[`typescript/__tests__/golden/fixtures/`](../typescript/__tests__/golden/fixtures/).

The golden fixtures are the machine-readable wire contract. Regenerate them with:

```bash
make golden
```

---

## Contents

- [Wire Format Conventions](#wire-format-conventions)
- [Error Conventions](#error-conventions)
- [Session Tools](#session-tools)
  - [interactive_openroad_query](#interactive_openroad_query)
  - [interactive_openroad_exec](#interactive_openroad_exec)
  - [create_interactive_session](#create_interactive_session)
  - [terminate_interactive_session](#terminate_interactive_session)
  - [list_interactive_sessions](#list_interactive_sessions)
  - [inspect_interactive_session](#inspect_interactive_session)
  - [get_session_history](#get_session_history)
  - [get_session_metrics](#get_session_metrics)
  - [grep_session_output](#grep_session_output)
- [Report Image Tools](#report-image-tools)
  - [list_report_images](#list_report_images)
  - [read_report_image](#read_report_image)
- [ORFS Metrics Tools](#orfs-metrics-tools)
  - [read_orfs_metrics](#read_orfs_metrics)
- [Flow Run Tools](#flow-run-tools)
  - [run_orfs_stage](#run_orfs_stage)
  - [get_orfs_job](#get_orfs_job)
  - [cancel_orfs_job](#cancel_orfs_job)
- [Session Lifecycle Notes](#session-lifecycle-notes)

---

## Wire Format Conventions

All tool responses carry a single MCP content item of type `"text"` whose `text` field is a JSON
string. **All JSON keys are snake_case** — the server converts camelCase models at the boundary
before serialising. `isError` is never set on any tool response; errors are signalled inside the
JSON payload itself.

Every result type has a nullable `error` field:

```
"error": null        // success
"error": "<string>"  // failure — human-readable or error-code string
```

---

## Error Conventions

### Normal Errors

All tools return a JSON object. On failure the `error` field is non-null and the rest of the
payload is either zero-valued or `null`. Example (blocked command):

```json
{
  "output": "",
  "session_id": "sess-0001",
  "timestamp": "2026-01-01T00:00:00",
  "execution_time": 0,
  "command_count": 0,
  "buffer_size": 0,
  "error": "CommandBlocked: 'exit'",
  "message": "Command blocked: 'exit' is not on the OpenROAD allowlist.\nFull command: 'exit'"
}
```

The `message` field is present **only** on blocked-command responses; it contains the human-readable
explanation alongside the machine-readable `error` code.

### Image-tool Error Codes

`list_report_images` and `read_report_image` use structured error codes in the `error` field:

| Code | Meaning |
|------|---------|
| `ValidationError` | Bad `platform`, `design`, path traversal attempt, or empty segment |
| `RunNotFound` | The run directory does not exist |
| `InvalidImageName` | `image_name` does not end in `.webp` |
| `ImageNotFound` | The named file is not present in the run directory |
| `NotAFile` | The path exists but is not a regular file |
| `FileTooLarge` | Image exceeds the 50 MB on-disk limit |
| `UnexpectedError` | Any other failure |

---

## Session Tools

### `interactive_openroad_query`

Execute a **read-only** OpenROAD command. The whitelist is default-deny: only `READONLY_PATTERNS`
(`report_*`, `get_*`, `check_*`, `sta`, `help`, `version`, and a set of safe Tcl built-ins) are
accepted. Everything else is rejected with `CommandBlocked`. See [SECURITY.md](SECURITY.md) for
full whitelist details.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `command` | string | **yes** | — |
| `session_id` | string | no | (auto-generates new session) |
| `timeout_ms` | integer | no | `30000` (`OPENROAD_COMMAND_TIMEOUT`) |

**Annotations:**
- `readOnlyHint: true`
- `destructiveHint: false`
- `idempotentHint: false`
- `openWorldHint: false`

**Response shape** (`interactive_exec_result_success.json`):

```json
{
  "output": "OpenROAD v2.0",
  "session_id": "sess-0001",
  "timestamp": "2026-01-01T00:00:00",
  "execution_time": 1.5,
  "command_count": 3,
  "buffer_size": 131072,
  "truncated": false,
  "bytes_discarded": 0,
  "total_bytes": 13,
  "error": null
}
```

| Field | Meaning |
|-------|---------|
| `output` | Everything OpenROAD wrote for this command, ANSI-stripped |
| `session_id` | The session used (auto-created if none was passed) |
| `execution_time` | Seconds spent on this command |
| `command_count` | Commands executed in this session so far |
| `buffer_size` | The session buffer's capacity in characters |
| `truncated` | `true` when output exceeded the buffer and its head was discarded |
| `bytes_discarded` | Characters dropped from the **start** of the output |
| `total_bytes` | Raw characters the command produced, before ANSI cleaning |

> **Truncation warning.** Output larger than the session buffer loses its **beginning**, not its
> end. When `truncated` is `true` the result is a **partial answer**: the retained text may start
> mid-line, and any error or warning printed before the cut is not in `output` and is not
> reflected in `error`. A truncated result also carries a `[TRUNCATED: ...]` banner at the head of
> `output`. Narrow the command and re-run rather than analysing what came back.

> **Session accumulation warning.** Omitting `session_id` creates a session and **leaves it
> running**. Capture the returned `session_id` and reuse it, or you will accumulate sessions
> until `OPENROAD_MAX_SESSIONS` (default 50) is reached and new commands fail.

---

### `interactive_openroad_exec`

Execute a **state-modifying** OpenROAD command. The whitelist is default-allow: only
`BLOCKED_COMMANDS` (`quit`, `socket`, `load`, `glob`, `fconfigure`, `chan`, `vwait`, `rename`,
`after`, `subst`) are rejected. Read-only commands such as `report_wns` are also accepted here —
use `interactive_openroad_query` when you want to keep state changes visible and auditable.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `command` | string | **yes** | — |
| `session_id` | string | no | (auto-generates new session) |
| `timeout_ms` | integer | no | `30000` (`OPENROAD_COMMAND_TIMEOUT`) |

**Annotations:**
- `readOnlyHint: false`
- `destructiveHint: true`
- `idempotentHint: false`
- `openWorldHint: false`

The response shape is identical to `interactive_openroad_query`. Long-running flow commands
routinely exceed 30 s — pass a larger `timeout_ms` for placement, CTS, and routing.

#### Rendering a layout or timing-path image from a session

A session is headless, but Qt renders offscreen, so `save_image` works — the GUI-only commands
(`gui::show_worst_path`, `gui::set_display_controls`) just need a GUI event loop to exist first.
`gui::show <script> false` provides one: it boots the GUI, runs the script, and returns. This is
how ORFS writes its own report images (`flow/scripts/final_report.tcl`).

```tcl
gui::show {gui::set_display_controls "Timing Path/*" visible true
           gui::show_worst_path
           save_image -width 1920 /tmp/worst_path.png} false
```

`-width` is independent of die size; ORFS instead computes `-resolution` from the block height,
which is why its images come out ~1000 px regardless of design.

Set `QT_QPA_PLATFORM=offscreen` in the session's `env` when no display is present (ORFS does this
automatically in `variables.mk`). A bare `gui::show`, or one left interactive, is **rejected** —
it blocks the Tcl event loop waiting on a human, leaving the session alive but permanently
unresponsive. The error message carries the working form.

Before rendering anything, check whether the run already has the image: ORFS emits
`final_worst_path.webp`, `final_congestion.webp` and others into `reports/`, and
[`read_report_image`](#read_report_image) returns them directly with no session at all.

---

### `create_interactive_session`

Create a session explicitly so you control its identifier, command, environment, and working
directory. Use this before a long flow to capture the `session_id` without running a first command.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `session_id` | string | no | random 8-char hex ID |
| `command` | string[] | no | `["openroad", "-no_init"]` |
| `env` | object | no | inherits server env |
| `cwd` | string | no | inherits server cwd |

**Annotations:**
- `readOnlyHint: false`
- `destructiveHint: false`
- `idempotentHint: false`
- `openWorldHint: false`

**Response shape** (`interactive_session_info_success.json`):

```json
{
  "session_id": "sess-0001",
  "created_at": "2026-01-01T00:00:00",
  "is_alive": true,
  "command_count": 5,
  "buffer_size": 4096,
  "uptime_seconds": 12.5,
  "state": "active",
  "error": null
}
```

`state` is one of `"creating"`, `"active"`, `"terminated"`, or `"error"`.

---

### `terminate_interactive_session`

Terminate a session. Sends SIGTERM; if `force` is true sends SIGKILL immediately.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `session_id` | string | **yes** | — |
| `force` | boolean | no | `false` |

**Annotations:**
- `readOnlyHint: false`
- `destructiveHint: true`
- `idempotentHint: true`
- `openWorldHint: false`

**Response shape** (`session_termination.json`):

```json
{
  "session_id": "sess-0001",
  "terminated": true,
  "was_alive": true,
  "force": false,
  "error": null
}
```

---

### `list_interactive_sessions`

List all sessions known to the server, both active and recently terminated.

No parameters.

**Annotations:**
- `readOnlyHint: true`
- `destructiveHint: false`
- `idempotentHint: true`
- `openWorldHint: false`

**Response shape** (`interactive_session_list.json`):

```json
{
  "sessions": [
    {
      "session_id": "sess-0001",
      "created_at": "2026-01-01T00:00:00",
      "is_alive": true,
      "command_count": 5,
      "buffer_size": 4096,
      "uptime_seconds": 12.5,
      "state": "active",
      "error": null
    },
    {
      "session_id": "sess-0002",
      "created_at": "2026-01-01T00:00:00",
      "is_alive": false,
      "command_count": 0,
      "buffer_size": 0,
      "uptime_seconds": null,
      "state": null,
      "error": "Session failed to start"
    }
  ],
  "total_count": 2,
  "active_count": 1,
  "error": null
}
```

---

### `inspect_interactive_session`

Return detailed metrics for a single session: buffer utilisation, memory, CPU time, idle
seconds, and history length.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `session_id` | string | **yes** | — |

**Annotations:**
- `readOnlyHint: true`
- `destructiveHint: false`
- `idempotentHint: true`
- `openWorldHint: false`

**Response shape** (`session_inspection.json`):

```json
{
  "session_id": "sess-0001",
  "metrics": {
    "session_id": "sess-0001",
    "state": "active",
    "is_alive": true,
    "created_at": "2026-01-01T00:00:00",
    "last_activity": "2026-01-01T00:00:00",
    "uptime_seconds": 12.5,
    "idle_seconds": 3.25,
    "commands": {
      "total_executed": 4,
      "current_count": 4,
      "history_length": 4
    },
    "performance": {
      "total_cpu_time": 1.5,
      "peak_memory_mb": 128,
      "current_memory_mb": 96
    },
    "buffer": {
      "current_size": 2048,
      "max_size": 131072,
      "utilization_percent": 1.5625
    },
    "timeout": {
      "configured_seconds": 300,
      "is_timed_out": false
    }
  },
  "error": null
}
```

---

### `get_session_history`

Retrieve the command history for a session, with optional limit and search filter.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `session_id` | string | **yes** | — |
| `limit` | integer | no | returns all (up to 1000) |
| `search` | string | no | no filter |

**Annotations:**
- `readOnlyHint: true`
- `destructiveHint: false`
- `idempotentHint: true`
- `openWorldHint: false`

**Response shape** (`session_history.json`):

```json
{
  "session_id": "sess-0001",
  "history": [
    {
      "command": "place_design",
      "timestamp": "2026-01-01T00:00:00",
      "command_number": 1,
      "execution_start": 1767225600,
      "execution_time": 0.75,
      "output_length": 42
    }
  ],
  "total_commands": 1,
  "limit": 10,
  "search": "place",
  "error": null
}
```

---

### `get_session_metrics`

Return aggregate metrics across all sessions: total/active/terminated counts, combined CPU time,
and per-session summaries.

No parameters.

**Annotations:**
- `readOnlyHint: true`
- `destructiveHint: false`
- `idempotentHint: true`
- `openWorldHint: false`

**Response shape** (`session_metrics.json`):

```json
{
  "metrics": {
    "manager": {
      "total_sessions": 2,
      "active_sessions": 1,
      "terminated_sessions": 1,
      "max_sessions": 10,
      "utilization_percent": 10
    },
    "aggregate": {
      "total_commands": 4,
      "total_cpu_time": 1.5,
      "total_memory_mb": 96,
      "avg_memory_per_session": 96
    },
    "sessions": [ "..." ]
  },
  "error": null
}
```

---

### `grep_session_output`

Search the output of commands already run in a session, without re-running them or re-sending a
large result.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `session_id` | string | **yes** | — |
| `pattern` | string | **yes** | — |
| `max_matches` | integer | no | `200` |
| `context_lines` | integer | no | `0` |
| `ignore_case` | boolean | no | `true` |
| `command_number` | integer | no | — (all retained commands) |

```json
{
  "session_id": "a1b2c3d4",
  "pattern": "wns",
  "matches": [
    { "command_number": 1, "command": "report_checks", "line_number": 42, "line": "wns max -0.485" }
  ],
  "total_matches": 1,
  "truncated": false,
  "pattern_kind": "regex",
  "searched_commands": 1,
  "searched_lines": 900,
  "retained_chars": 131166,
  "evicted_commands": 0,
  "message": null,
  "error": null
}
```

| Field | Meaning |
|-------|---------|
| `total_matches` | Matches found, which exceeds `matches.length` when capped by `max_matches` |
| `truncated` | `true` when matches were dropped — the list is not the whole answer |
| `pattern_kind` | How the pattern was applied; see below |
| `searched_commands` / `searched_lines` | How much was actually searched |
| `retained_chars` | Characters of output currently held for this session |
| `evicted_commands` | Commands whose output has aged out of the retention budget |

**Pattern handling.** `pattern` is a regular expression. `pattern_kind` reports what actually
happened:

- `regex` — compiled and applied as a regex.
- `substring` — the pattern did not compile, so it was applied literally. Pasting a raw name is not
  treated as a user error.
- `substring-fallback` — the pattern compiled *and matched nothing*, and it contains regex
  metacharacters, so it was retried literally and that found matches. A pasted instance name like
  `dpath.a_reg[0]` is valid regex meaning "…`a_reg` followed by `0`", which silently matches
  nothing — worse than a syntax error, because you would be told there are no matches when it is
  the pattern that is wrong.

> **Only recent output is searchable.** `runCommand` drains the session's circular buffer, so the
> live buffer holds nothing once a command has returned. Output is therefore retained separately,
> bounded by `OPENROAD_OUTPUT_HISTORY_CHARS` (default 256 KB) and
> `OPENROAD_OUTPUT_HISTORY_COMMANDS` (default 50), oldest evicted first. `evicted_commands` tells
> you when something has aged out. A single result larger than the whole budget keeps its tail.

---

## Report Image Tools

### `list_report_images`

List `.webp` report images produced by an ORFS run, grouped by pipeline stage. Requires
`ORFS_FLOW_PATH` to point at your ORFS `flow/` directory.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `platform` | string | **yes** | — |
| `design` | string | **yes** | — |
| `run_slug` | string | **yes** | — |
| `stage` | string | no | `"all"` |

`platform` and `design` are validated against subdirectories discovered under
`{ORFS_FLOW_PATH}/platforms/` and `{ORFS_FLOW_PATH}/designs/{platform}/`. `run_slug` may not
contain path separators, `..`, or glob characters.

**Annotations:**
- `readOnlyHint: true`
- `destructiveHint: false`
- `idempotentHint: true`
- `openWorldHint: false`

**Response shape** (`list_images.json`):

```json
{
  "run_path": "/reports/nangate45/gcd/base",
  "total_images": 2,
  "images_by_stage": {
    "floorplan": [
      {
        "filename": "floorplan.webp",
        "path": "/reports/nangate45/gcd/base/floorplan.webp",
        "size_bytes": 15000,
        "modified_time": "2026-01-01T00:00:00",
        "type": "unknown"
      }
    ]
  },
  "message": null,
  "error": null
}
```

`type` is `"unknown"` for filenames that are not in the known mapping (see
[SECURITY.md](SECURITY.md#report-image-path-containment) for the full list).

When no images are found: `run_path`, `total_images`, and `images_by_stage` are `null` and
`message` is `"No images found"`.

---

### `read_report_image`

Read a single report image and return it as a **real MCP image content block** a vision model can
see, plus a text block carrying the metadata. The base64 payload is *not* repeated in the text
block.

Images are downscaled only as far as their byte budget actually requires: the longest edge is
capped at `OPENROAD_IMAGE_MAX_DIMENSION` (default 1568 px, the resolution vision models downsample
to anyway), then a size/quality ladder steps down only while the encoding still exceeds
`OPENROAD_IMAGE_MAX_BASE64_KB` (default 1024 KB of base64), never below
`OPENROAD_IMAGE_MIN_DIMENSION` (default 512 px). Most report images now pass through untouched.
The 50 MB on-disk limit is enforced before any resizing.

**Quality is shed before resolution.** Every quality rung (85, 70, 55) is tried at the current
size before the image is made smaller, and the first encoding that fits the budget is returned.
A congestion or routing map carries its signal in fine wire and via detail, which downsampling
destroys outright, while WebP quality loss degrades it gracefully — so a full-resolution q70
image is returned in preference to a downscaled q85 one. `width`/`height` in the response are
the dimensions actually returned; compare them against `original_width`/`original_height` to see
whether resizing was reached at all.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `platform` | string | **yes** | — |
| `design` | string | **yes** | — |
| `run_slug` | string | **yes** | — |
| `image_name` | string | **yes** | — |
| `max_size_kb` | integer | no | `OPENROAD_IMAGE_MAX_BASE64_KB` |

`max_size_kb` overrides the base64 budget for a single call — lower it for a quick thumbnail,
raise it when a heatmap needs more detail.

`image_name` must end in `.webp` and may not contain path separators or traversal sequences.

**Annotations:**
- `readOnlyHint: true`
- `destructiveHint: false`
- `idempotentHint: true`
- `openWorldHint: false`

**Response shape.** The tool returns two content blocks:

```
[ { "type": "image", "data": "<base64>", "mimeType": "image/webp" },
  { "type": "text",  "text": "<the JSON below, without image_data>" } ]
```

The underlying JSON payload (`read_image.json`, as returned by the library API which still
includes `image_data`):

```json
{
  "image_data": "<base64>",
  "metadata": {
    "filename": "cts_clk.webp",
    "format": "webp",
    "size_bytes": 15000,
    "width": 1024,
    "height": 768,
    "modified_time": "2026-01-01T00:00:00",
    "stage": "cts",
    "type": "unknown",
    "compression_applied": true,
    "original_size_bytes": 48000,
    "original_width": 2048,
    "original_height": 1536,
    "compression_ratio": 3.2
  },
  "message": null,
  "error": null
}
```

`compression_ratio` is `original_size_bytes / size_bytes`. `compression_applied` is `true` only
when the image actually had to be re-encoded; `format` is sniffed from the bytes rather than
guessed from the filename, so the doubled `.webp.png` form some ORFS builds emit is reported
correctly.

**Error response** (`read_image_error.json`):

```json
{
  "image_data": null,
  "metadata": null,
  "message": "Image not found: foo.webp",
  "error": "ImageNotFound"
}
```

---

## ORFS Metrics Tools

### `read_orfs_metrics`

Read a design's per-stage metrics and surface the tagged errors and warnings from each stage log —
in one call. This replaces the `find` + `cat` + `jq` + `grep` sequence over the flow tree that
accounted for roughly 39% of all shell usage in the capability study.

This tool does not judge QoR. ORFS keeps no rule thresholds in the flow tree: its `metadata` target
checks the run against the QoR dashboard and writes the verdict to
`reports/<platform>/<design>/<variant>/metadata-check.log`. Use
[run_orfs_stage](#run_orfs_stage) with `stage: "metadata"` to run that check.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `design` | string | **yes** | — |
| `stage` | string | no | `all` |
| `platform` | string | no | inferred from `design` |
| `variant` | string | no | `base` |

`platform` is inferred when the design name is unique across platforms; if it is not, the error
names the candidates. `design` and `variant` are validated as single path segments.

**Stage resolution.** `stage` is matched, in order, against:

1. an exact file stem — `4_1_cts`
2. an **ORFS metric namespace** — `placeopt`, `detailedplace`, `globalplace`, `globalroute`,
   `detailedroute`, `finish`. These matter because ORFS names metrics by namespace
   (`globalroute__timing__setup__ws`) while the file on disk is `5_1_grt.json`.
3. an everyday **stage group** — `synth`, `floorplan`, `place`, `cts`, `route`, `finish`, which
   expand to every step in that group (`place` → all five `3_*` files)
4. a plain substring of the stem
5. `all` (the default) — every stage

Stages are discovered from the logs directory rather than a hardcoded table, so a renumbered ORFS
release still resolves. An unmatched stage returns `StageNotFound` listing the stems present.

> **Repeated metrics are arrays.** ORFS appends a block of metrics per sub-run, so a stage file
> legitimately contains the same key more than once — the real `4_1_cts.json` has 63 key
> occurrences across 55 distinct keys, recording `cts__utilization__before__dpl` as both `76.7787`
> and `82.1146`. A plain `JSON.parse` keeps only the last and reports nothing. This tool returns
> **every** value, in file order, and names those keys in `repeated_metrics` so you can tell an
> array from a scalar without inspecting each value.

**Response shape:**

```json
{
  "platform": "nangate45",
  "design": "gcd",
  "variant": "base",
  "stage": "cts",
  "logs_path": "logs/nangate45/gcd/base",
  "available_stages": ["1_synth", "2_1_floorplan", "...", "6_report"],
  "stages": [
    {
      "stage": "4_1_cts",
      "metrics_path": "logs/nangate45/gcd/base/4_1_cts.json",
      "metrics": {
        "cts__utilization__before__dpl": [76.7787, 82.1146],
        "cts__timing__setup__ws": -0.113089,
        "cts__design__violations": 0
      },
      "repeated_metrics": ["cts__utilization__before__dpl"],
      "log": {
        "path": "logs/nangate45/gcd/base/4_1_cts.log",
        "errors": ["[ERROR ORD-2018] Pin is not ITerm or BTerm or modITerm."],
        "warnings": [],
        "error_count": 1,
        "warning_count": 0,
        "truncated": false
      },
      "error": null
    }
  ],
  "gates": [],
  "unmatched_gates": [],
  "gate_summary": {
    "total": 0, "pass": 0, "fail": 0, "unknown": 0,
    "failing_errors": 0, "failing_warnings": 0, "unmatched": 0
  },
  "rules_path": null,
  "message": null,
  "error": null
}
```

| Field | Meaning |
|-------|---------|
| `stages[].metrics` | The stage's metrics; a value is an **array** iff its key is in `repeated_metrics` |
| `stages[].metrics_path` | `null` when the stage produced a log but no metrics file (a crashed stage) |
| `stages[].error` | `MalformedMetrics: ...` when the JSON is half-written; the stage is still returned |
| `stages[].log.truncated` | `true` when more diagnostics existed than the 50-per-category listed |
| `gates` | **Deprecated.** Always `[]` |
| `unmatched_gates` | **Deprecated.** Always `[]` |
| `gate_summary` | **Deprecated.** Every count is `0`; `null` when the call fails |
| `rules_path` | **Deprecated.** Always `null` |

The four deprecated fields stay in the result so that existing callers do not break. ORFS removed
its per-design rules files, so this tool has no rules to judge. Run the ORFS `metadata` target to
check QoR.

All paths are returned **relative to the ORFS flow root**, never as absolute host paths.

**Error codes:** `ValidationError` (bad design/variant/platform, or path traversal), `RunNotFound`
(no such variant; the message lists those present), `StageNotFound` (the message lists the stems
present).

---

## Flow Run Tools

Run an ORFS stage through the server instead of shelling out to `make`. Output streams to a file —
never through the session's 128 KB circular buffer, which would keep only the tail of a route log.

> **What "inspectable" means here.** A `make`-spawned OpenROAD is a separate process this server
> does not own, so **its Tcl interpreter cannot be queried mid-run**. `get_orfs_job` gives
> *structured job progress* — stage, iteration, live violation count, CPU and memory — which is what
> a caller would otherwise hand-roll from `tail`, `grep`, `ps` and `stat`. It is not live access to
> the running interpreter.

### `run_orfs_stage`

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `design` | string | **yes** | — |
| `stage` | string | **yes** | — |
| `overrides` | object | no | `{}` |
| `platform` | string | no | inferred from `design` |
| `variant` | string | no | `base` |
| `wait_seconds` | integer | no | — (return immediately) |
| `jobs` | integer | no | — (make default) |
| `timeout_seconds` | integer | no | `OPENROAD_FLOW_RUN_TIMEOUT` (6 h) |
| `dry_run` | boolean | no | `false` |

Returns a `job_id` immediately so a multi-hour route does not block the call. Pass `wait_seconds`
to get the finished result inline when the stage is short. `dry_run: true` runs `make -n`, showing
which stages the target would chain without running any of them.

`overrides` become **make command-line assignments**, which take precedence over both the
environment and the Makefile:

```json
{ "design": "gcd", "stage": "cts", "overrides": { "CTS_CLUSTER_SIZE": "20" } }
```

Override names are returned verbatim, not converted to snake_case.

**Allowed `stage` values:** `synth`, `floorplan`, `place`, `cts`, `grt`, `route`, `finish`, `all`,
`metadata`, and `clean_synth` / `clean_floorplan` / `clean_place` / `clean_cts` / `clean_route` /
`clean_finish` / `clean_metadata` / `clean_all`. Anything else is rejected — see
[SECURITY.md](SECURITY.md) for why the allowlist exists and which override names are refused.

**Annotations:** `readOnlyHint: false`, `destructiveHint: true` — it writes into the flow tree, and
the `clean_*` targets delete results.

### `get_orfs_job`

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `job_id` | string | no | — (list every run) |
| `recent_lines` | integer | no | `50` |

```json
{
  "job_id": "a3f2c1d0",
  "status": "running",
  "design": "ibex",
  "stage": "route",
  "command": "make route DESIGN_CONFIG=./designs/sky130hd/ibex/config.mk FLOW_VARIANT=base",
  "elapsed_seconds": 1840,
  "progress": {
    "current_stage": "5_2_route",
    "iteration": 1,
    "percent": 80,
    "violations": 19604,
    "iteration_violations": 20,
    "cpu_seconds": 1802,
    "memory_mb": 4210.5,
    "peak_memory_mb": 4300.0
  },
  "recent_lines": ["    Completing 80% with 19604 violations."],
  "log_path": "/tmp/openroad-mcp-runs/a3f2c1d0.log",
  "log_bytes": 48210934,
  "log_truncated": true,
  "stages": [],
  "gates": [],
  "gate_summary": null,
  "error": null
}
```

`status` is `running`, `succeeded`, `failed`, `cancelled` or `timed_out`, with `exit_code` always
present once finished. **On success the result also carries `stages`** in the same shape
[read_orfs_metrics](#read_orfs_metrics) returns — including repeated metrics as arrays.

`gates` and `gate_summary` are **deprecated**. `gates` is always `[]`. `gate_summary` is `null`
until the run succeeds, and then every count is `0`. ORFS removed its per-design rules files; run
the ORFS `metadata` target to check QoR.

`current_stage` comes from the newest `*.tmp.log` in the run's logs directory: ORFS writes each
stage to `<stem>.tmp.log` and renames it to `<stem>.log` on success, so this tracks the flow without
depending on stage numbering. `cpu_seconds` and `memory_mb` come from OpenROAD's own `DRT-0267`
line, not from sampling the `make` pid — the process consuming the machine is a grandchild.

`log_truncated` reports that the log holds more than the lines returned; `log_bytes` is the true
total.

### `cancel_orfs_job`

| Parameter | Type | Required |
|-----------|------|----------|
| `job_id` | string | **yes** |

Signals the run's **entire process group**, then escalates to `SIGKILL` after a grace period.
Killing only `make` would strand the `openroad` it spawned. Running jobs are also torn down on
server shutdown.

**Error codes** across these tools: `ValidationError` (bad design/variant/stage/override),
`FlowJobLimit` (concurrency cap reached), `FlowJobNotFound`, `FlowPathNotFound`.

---

## Session Lifecycle Notes

### Limits

| Limit | Default | Environment Variable |
|-------|---------|----------------------|
| Max concurrent sessions | 50 | `OPENROAD_MAX_SESSIONS` |
| Output buffer per session | 128 KiB | `OPENROAD_DEFAULT_BUFFER_SIZE` |
| Command history per session | 1000 entries | (constant) |
| Default command timeout | 30 s | `OPENROAD_COMMAND_TIMEOUT` |
| Input queue depth | 128 commands | `OPENROAD_SESSION_QUEUE_SIZE` |
| Report-image payload | 1024 KB base64 | `OPENROAD_IMAGE_MAX_BASE64_KB` |
| Report-image longest edge | 1568 px | `OPENROAD_IMAGE_MAX_DIMENSION` |
| Report-image resize floor | 512 px | `OPENROAD_IMAGE_MIN_DIMENSION` |
| Searchable output per session | 256 KB | `OPENROAD_OUTPUT_HISTORY_CHARS` |
| Searchable commands per session | 50 | `OPENROAD_OUTPUT_HISTORY_COMMANDS` |
| Concurrent flow runs | 2 | `OPENROAD_MAX_FLOW_JOBS` |
| Flow run timeout | 6 h | `OPENROAD_FLOW_RUN_TIMEOUT` |
| Flow run log directory | `<tmpdir>/openroad-mcp-runs` | `OPENROAD_RUN_LOG_DIR` |

### Idle Session Accumulation

Idle sessions are **not automatically reaped**. The `cleanupIdleSessions` function exists in the
manager but no scheduler calls it in production. Sessions persist until manually terminated, the
process exits, or the underlying OpenROAD process dies. Plan your session lifecycle explicitly or
you will hit `OPENROAD_MAX_SESSIONS`.

`OPENROAD_SESSION_IDLE_TIMEOUT` (default 300 s) is read by `inspect_interactive_session` and
reported in the `timeout` block; it does not trigger any automatic cleanup.
