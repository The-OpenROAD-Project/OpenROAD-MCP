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

Ask the user which MCP client they use if it's not obvious, then apply the
matching configuration. These snippets are kept in sync with the
[README's "Supported MCP Clients" section](https://github.com/The-OpenROAD-Project/openroad-mcp#supported-mcp-clients) —
treat the README as the source of truth if the two ever drift. The standard
STDIO config used by most clients is:

```json
{
  "command": "npx",
  "args": ["-y", "openroad-mcp"]
}
```

### Claude Code (CLI)

```bash
claude mcp add --transport stdio openroad-mcp -- npx -y openroad-mcp
```

If a GUI-launched client can't find `openroad`, pass PATH/ORFS overrides. Use
`command -v` so paths are never hard-coded, and keep `--transport` **between**
the `--env` flags and the server name:

```bash
claude mcp add \
  --env PATH="$(dirname "$(command -v openroad)"):${PATH}" \
  --env ORFS_FLOW_PATH="${HOME}/OpenROAD-flow-scripts/flow" \
  --transport stdio openroad-mcp \
  -- npx -y openroad-mcp
```

### Claude Desktop

Add the standard config under `mcpServers` in:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "openroad-mcp": { "command": "npx", "args": ["-y", "openroad-mcp"] }
  }
}
```

### Cursor

Add the standard config under `mcpServers` in `.cursor/mcp.json`.

### GitHub Copilot (VS Code)

Add to `.vscode/mcp.json` — requires `"type": "stdio"`:

```json
{
  "servers": {
    "openroad-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "openroad-mcp"]
    }
  }
}
```

### Windsurf

Add the standard config to `~/.codeium/windsurf/mcp_config.json`.

### Cline / Roo Code

Add the standard config to `cline_mcp_settings.json` (Cline) or `.roo/mcp.json` (Roo Code).

### Continue / PearAI

Add to the respective `config.json` under `modelContextProtocolServers`:

```json
{
  "transport": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "openroad-mcp"]
  }
}
```

### Zed

Add to `~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "openroad-mcp": {
      "command": { "path": "npx", "args": ["-y", "openroad-mcp"] }
    }
  }
}
```

### Docker / other STDIO clients

The server is on the [MCP Registry](https://registry.modelcontextprotocol.io) and
GHCR. Any standard STDIO client works; for Docker:

```bash
docker run --rm -i ghcr.io/the-openroad-project/openroad-mcp:latest
```

> **PATH note for GUI clients:** apps launched from a dock/Finder often don't
> inherit your shell `PATH`. The server tries hard to locate `openroad` (current
> PATH → login-shell PATH → common install dirs like `/opt/homebrew/bin`, conda,
> local builds), but if it still fails, set the `PATH` env override as shown in
> the Claude Code example.

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
