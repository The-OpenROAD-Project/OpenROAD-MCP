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
- [Report Image Tools](#report-image-tools)
  - [list_report_images](#list_report_images)
  - [read_report_image](#read_report_image)
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
  "buffer_size": 2048,
  "error": null
}
```

| Field | Meaning |
|-------|---------|
| `output` | Everything OpenROAD wrote for this command, ANSI-stripped |
| `session_id` | The session used (auto-created if none was passed) |
| `execution_time` | Seconds spent on this command |
| `command_count` | Commands executed in this session so far |
| `buffer_size` | Current output-buffer occupancy in bytes |

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

Read a single `.webp` image and return its base64-encoded data with metadata. Images larger
than 15 KB (base64) are automatically downscaled using sharp (lanczos3, WebP quality 85) before
encoding. The 50 MB on-disk limit is enforced before any resizing.

| Parameter | Type | Required | Default |
|-----------|------|----------|---------|
| `platform` | string | **yes** | — |
| `design` | string | **yes** | — |
| `run_slug` | string | **yes** | — |
| `image_name` | string | **yes** | — |

`image_name` must end in `.webp` and may not contain path separators or traversal sequences.

**Annotations:**
- `readOnlyHint: true`
- `destructiveHint: false`
- `idempotentHint: true`
- `openWorldHint: false`

**Response shape** (`read_image.json`):

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

`compression_ratio` is `original_size_bytes / size_bytes`. `compression_applied` is `true`
when the original exceeded 15 KB (base64).

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

## Session Lifecycle Notes

### Limits

| Limit | Default | Environment Variable |
|-------|---------|----------------------|
| Max concurrent sessions | 50 | `OPENROAD_MAX_SESSIONS` |
| Output buffer per session | 128 KiB | `OPENROAD_DEFAULT_BUFFER_SIZE` |
| Command history per session | 1000 entries | (constant) |
| Default command timeout | 30 s | `OPENROAD_COMMAND_TIMEOUT` |
| Input queue depth | 128 commands | `OPENROAD_SESSION_QUEUE_SIZE` |

### Idle Session Accumulation

Idle sessions are **not automatically reaped**. The `cleanupIdleSessions` function exists in the
manager but no scheduler calls it in production. Sessions persist until manually terminated, the
process exits, or the underlying OpenROAD process dies. Plan your session lifecycle explicitly or
you will hit `OPENROAD_MAX_SESSIONS`.

`OPENROAD_SESSION_IDLE_TIMEOUT` (default 300 s) is read by `inspect_interactive_session` and
reported in the `timeout` block; it does not trigger any automatic cleanup.
