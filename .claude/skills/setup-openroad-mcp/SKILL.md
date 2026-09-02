---
name: setup-openroad-mcp
description: |
  Install and configure the OpenROAD MCP server so an AI assistant can drive
  OpenROAD / OpenROAD-flow-scripts (ORFS) for physical design, timing, power,
  and report analysis. Handles prerequisite checks (Node.js 22+, `openroad` in
  PATH, optional ORFS), client registration (Claude Code, Claude Desktop,
  Cursor, VS Code/Copilot, Windsurf, Cline/Roo, Continue, PearAI, Zed, Docker),
  and a connection smoke test.

  Use this skill whenever the user asks to:
  - Set up, install, configure, or connect the OpenROAD MCP server
  - Add openroad-mcp to Claude Code / Cursor / VS Code / Claude Desktop / etc.
  - Get their AI assistant talking to OpenROAD or ORFS
  - Troubleshoot "OpenROAD tools not available" or "openroad not found" in an MCP client

  Trigger on phrases like "set up openroad-mcp", "install the OpenROAD MCP",
  "connect Claude to OpenROAD", "add openroad mcp to cursor", "configure ORFS
  for my assistant", or "the OpenROAD MCP isn't connecting".
---

# Set Up OpenROAD MCP

This skill installs and configures the [OpenROAD MCP server](https://github.com/The-OpenROAD-Project/openroad-mcp),
a Model Context Protocol server that connects an AI assistant to the OpenROAD
physical-design tools and OpenROAD-flow-scripts (ORFS).

The published server runs via `npx` — **there is no need to clone this repo** for
normal use. Configuration is just: check prerequisites → register the server with
the MCP client → verify the connection.

## Step 1: Check prerequisites

Run these checks and report what's missing before touching any config.

**Node.js 22+** (required — runs the `npx` distribution):

```bash
node --version
```

If it's older than v22 or missing, install Node 22+ (via the official installer,
`nvm`, or your package manager) before continuing.

**OpenROAD in `PATH`** (required — the actual layout engine):

```bash
command -v openroad && openroad -version
```

If `openroad` is not found, it must be installed and on `PATH`. Point the user to
the [OpenROAD build guide](https://openroad.readthedocs.io/en/latest/user/Build.html).
Note the directory from `command -v openroad` — you may need it in Step 2 for
GUI-launched clients that don't inherit a login shell `PATH`.

**OpenROAD-flow-scripts / ORFS** (optional — enables full RTL-to-GDS flows and
report images):

```bash
ls "${ORFS_FLOW_PATH:-$HOME/OpenROAD-flow-scripts/flow}" 2>/dev/null \
  && echo "ORFS found" || echo "ORFS not found (optional)"
```

`ORFS_FLOW_PATH` defaults to `~/OpenROAD-flow-scripts/flow`. If ORFS lives
elsewhere, note the path for Step 2. See the
[ORFS build guide](https://openroad-flow-scripts.readthedocs.io/en/latest/user/BuildLocally.html).

## Step 2: Register the server with the MCP client

Ask the user which MCP client they use if it's not obvious. The per-client
configuration snippets and file locations are maintained as a single source of
truth in the
[README's "Supported MCP Clients" section](https://github.com/The-OpenROAD-Project/openroad-mcp#supported-mcp-clients).
Read that section, then apply the snippet for the client the user named (it
covers Claude Code, Claude Desktop, Cursor, GitHub Copilot, Windsurf, Cline /
Roo Code, Continue / PearAI, Zed, and Docker).

> **PATH note for GUI clients:** apps launched from a dock/Finder often don't
> inherit your shell `PATH`. The server tries hard to locate `openroad` (current
> PATH → login-shell PATH → common install dirs like `/opt/homebrew/bin`, conda,
> local builds), but if it still fails, pass the `PATH` env override shown in the
> README's Supported MCP Clients section.

## Step 3: Restart and verify the connection

MCP clients scan servers at startup — **restart the client** (or the CLI session)
after editing config so it picks up the new server.

Then run the smoke test by asking the assistant, in plain language:

> "Are your OpenROAD tools available and ready to use?"

A working setup exposes tools including `create_interactive_session`,
`interactive_openroad_query`, `interactive_openroad_exec`, and `read_report_image`.

Then confirm end to end:

> "Create a new OpenROAD session and tell me what version of OpenROAD we are running."

Expected: the assistant calls `create_interactive_session()` then
`interactive_openroad_query("version")` and returns something like
`OpenROAD v2.0-14023-g05f7f46af`.

## Troubleshooting

- **"OpenROAD tools not available"** → the server didn't register. Recheck the
  client config file/location and that the client was restarted.
- **"openroad: command not found" / server exits immediately** → `openroad`
  isn't on the `PATH` the client sees. Add the `PATH` env override (Step 2,
  Claude Code example) or launch the client from a shell where `openroad` works.
- **ORFS features / report images missing** → set `ORFS_FLOW_PATH` to the ORFS
  `flow` directory (default `~/OpenROAD-flow-scripts/flow`).
- **`npx` fails to fetch the package** → confirm Node 22+ and network access;
  the first run downloads `openroad-mcp`.

## Next steps

Point the user to the [Quick Start Guide](https://github.com/The-OpenROAD-Project/openroad-mcp/blob/main/docs/QUICKSTART.md)
for proven prompt patterns (timing/power analysis, design introspection, ORFS
report visualization) once the connection is verified.
