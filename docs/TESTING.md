# OpenROAD MCP — Real-Flow Testing Checklist

This document is an executable checklist for manually verifying end-to-end correctness of the
OpenROAD MCP server against real ORFS flows. Complete it before tagging any v1.0+ release.

Run the automated suites first:

```bash
make test-all          # unit + integration + performance
make golden            # assert no fixture drift
```

The sections below require a machine with OpenROAD and ORFS installed.

---

## Prerequisites

| requirement | check |
|---|---|
| OpenROAD on PATH | `openroad -version` returns a build string |
| ORFS flow directory exists | `ls $ORFS_FLOW_PATH` (default `~/OpenROAD-flow-scripts/flow`) |
| MCP server starts | `npx -y openroad-mcp --help` exits 0 |
| `.orfs-eval-logs/` populated from a prior run | at least one design with CTS logs |

---

## 1. Server startup and session creation

| # | action | expected | observed |
|---|---|---|---|
| 1.1 | `npx -y openroad-mcp` starts with stdio transport | server starts, writes JSON-RPC init to stdout | |
| 1.2 | `docker run --rm -i ghcr.io/the-openroad-project/openroad-mcp:latest --help` | exits 0, prints usage | |
| 1.3 | Call `create_interactive_session` with no args | returns `session_id`, `state: "active"`, `is_alive: true` | |
| 1.4 | Call `list_interactive_sessions` | lists the session created in 1.3 | |
| 1.5 | Call `terminate_interactive_session` with the id | returns `terminated: true` | |
| 1.6 | Call `get_session_metrics` | `active_sessions: 0`, `terminated_sessions: 1` | |

---

## 2. Query tool whitelist

| # | command | expected | observed |
|---|---|---|---|
| 2.1 | `interactive_openroad_query("version")` | `output` contains OpenROAD version string, `error: null` | |
| 2.2 | `interactive_openroad_query("help")` | `output` contains help text | |
| 2.3 | `interactive_openroad_query("set_wire_rc -layer metal3")` | `error: "CommandBlocked: 'set_wire_rc'"` | |
| 2.4 | `interactive_openroad_query("source my.tcl")` | `error: "CommandBlocked: 'source'"` | |
| 2.5 | `interactive_openroad_query("exit")` | `error: "CommandBlocked: 'exit'"` | |
| 2.6 | `interactive_openroad_query("exec ls")` | `error: "CommandBlocked: 'exec'"` | |

---

## 3. Exec tool on a real design

Use the GCD (`gcd`) design on `nangate45` — included in every ORFS install.

| # | action | expected | observed |
|---|---|---|---|
| 3.1 | Create session with `cwd` pointing at ORFS flow dir | `state: "active"` | |
| 3.2 | `interactive_openroad_exec("source designs/nangate45/gcd/config.mk")` | `error: null` (or harmless Tcl output) | |
| 3.3 | `interactive_openroad_exec("read_lef platforms/nangate45/lef/NangateOpenCellLibrary.tech.lef")` | `error: null` | |
| 3.4 | `interactive_openroad_exec("read_lef platforms/nangate45/lef/NangateOpenCellLibrary.macro.lef")` | `error: null` | |
| 3.5 | `interactive_openroad_exec("read_verilog <path/to/gcd.v>")` | `error: null`, `output` includes "Reading design" | |
| 3.6 | `interactive_openroad_exec("initialize_floorplan -utilization 30 -aspect_ratio 1.0 -core_space 2.0")` | `error: null`, floor plan created | |
| 3.7 | `interactive_openroad_query("report_design_area")` | `error: null`, `output` contains area values | |
| 3.8 | Session accumulates commands — check `inspect_interactive_session` | `commands.current_count` increments each call | |
| 3.9 | Long-running `global_placement` with `timeout_ms: 120000` | completes without timeout error | |

---

## 4. Report images

Populate `ORFS_FLOW_PATH` and run a design to produce `.webp` images. The GCD flow generates
placement and routing images under `flow/reports/nangate45/gcd/<run_slug>/`.

| # | action | expected | observed |
|---|---|---|---|
| 4.1 | `list_report_images(platform, design, run_slug)` | `total_images > 0`, no error | |
| 4.2 | `list_report_images(platform, design, run_slug, stage: "3_place")` | only placement images listed | |
| 4.3 | `read_report_image(platform, design, run_slug, "3_place_gp_overlay.webp")` | `image_data` is non-empty base64, `error: null` | |
| 4.4 | `read_report_image` on a >50 MB image | `error: "FileTooLarge"` | |
| 4.5 | `read_report_image` with traversal: `image_name: "../../../etc/passwd.webp"` | `error: "ValidationError"` | |
| 4.6 | `list_report_images` with non-existent run_slug | `error: "RunNotFound"` | |

---

## 5. Session limits

| # | action | expected | observed |
|---|---|---|---|
| 5.1 | Create 51 sessions without terminating any | 51st returns `error: "session limit reached"` | |
| 5.2 | `get_session_metrics` after 50 active sessions | `utilization_percent: 100` | |
| 5.3 | Terminate 10 sessions, then create 10 new ones | all succeed | |

---

## 6. HTTP transport

```bash
npx -y openroad-mcp --transport http --port 8555 &
```

| # | action | expected | observed |
|---|---|---|---|
| 6.1 | Send a `tools/list` request to `http://localhost:8555/mcp` | returns all 10 tools | |
| 6.2 | `interactive_openroad_query("version")` via HTTP | same response as stdio | |
| 6.3 | Two consecutive HTTP requests with the same `session_id` | second call sees history from first | |
| 6.4 | Oversized body (>1 MB) | HTTP 400 | |

---

## 7. AutoTuner comparison

This section compares MCP-assisted parameter tuning against
[ORFS AutoTuner](https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts/tree/master/flow/util/autotuner).

Coordinate with Chaitanya for baseline runs and scoring methodology. Fill in observed values from
`.orfs-eval-logs/`.

| metric | AutoTuner baseline | MCP-assisted | delta |
|---|---|---|---|
| ibex — WNS after CTS (ns) | | | |
| ibex — TNS after CTS (ns) | | | |
| ibex — total runtime (min) | | | |
| aes — WNS after CTS (ns) | | | |
| aes — TNS after CTS (ns) | | | |
| aes — total runtime (min) | | | |
| gcd — WNS after CTS (ns) | | | |
| gcd — total runtime (min) | | | |

**Notes on methodology:**

- AutoTuner baseline: run with default knobs, same target clock period.
- MCP-assisted: Claude or another AI drives `interactive_openroad_exec` to iteratively tune
  `set_wire_rc`, `repair_timing`, and `clock_tree_synthesis` parameters.
- Both runs use the same ORFS version (`ORFS_VERSION` in Makefile) and the same machine.
- Record the agent transcript and `.orfs-eval-logs/` outputs as evidence.

**This checklist is a gate on tagging v1.0.0.** Do not tag until all rows in sections 1–6 have
observed values and the AutoTuner comparison is filled in.
