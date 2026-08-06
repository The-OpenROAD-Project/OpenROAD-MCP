# openroad-mcp

An [MCP](https://modelcontextprotocol.io/) server that provides tools for interacting with
[OpenROAD](https://theopenroadproject.org/) and
[OpenROAD-flow-scripts (ORFS)](https://openroad-flow-scripts.readthedocs.io/).

---

## Requirements

- **Node.js 22+**
- **OpenROAD** installed and on your `PATH`
  ([installation guide](https://openroad.readthedocs.io/en/latest/main/GettingStarted.html))
- **OpenROAD-flow-scripts** for report image tools (optional)

---

## Quick start

Add this to your MCP client configuration:

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

See the [full installation guide](https://github.com/The-OpenROAD-Project/openroad-mcp#installation)
for per-client configuration for Cursor, Claude Code, GitHub Copilot, and 25+ other clients.

---

## Tools

| tool | description |
|---|---|
| `interactive_openroad_query` | Execute a read-only OpenROAD command (whitelist-enforced) |
| `interactive_openroad_exec` | Execute a state-modifying OpenROAD command |
| `create_interactive_session` | Create a named session with custom command and environment |
| `list_interactive_sessions` | List all active and terminated sessions |
| `terminate_interactive_session` | Terminate a session (SIGTERM or SIGKILL) |
| `inspect_interactive_session` | Detailed metrics for one session |
| `get_session_history` | Command history with optional limit and search |
| `get_session_metrics` | Aggregate metrics across all sessions |
| `list_report_images` | List `.webp` report images from an ORFS run |
| `read_report_image` | Read and base64-encode a single report image |

Full parameter reference and wire-format shapes: [docs/API.md](https://github.com/The-OpenROAD-Project/openroad-mcp/blob/main/docs/API.md)

---

## Security model

The server enforces a three-tier Tcl command whitelist on commands sent to OpenROAD:

- **`BLOCKED_COMMANDS`** — rejected in both tools (OS-level escape vectors)
- **`EXEC_ONLY_PATTERNS`** — rejected in `interactive_openroad_query`, allowed in `interactive_openroad_exec`
- **`READONLY_PATTERNS`** — allowed in both tools

Details: [docs/SECURITY.md](https://github.com/The-OpenROAD-Project/openroad-mcp/blob/main/docs/SECURITY.md)

---

## Docker

```bash
docker run --rm -i ghcr.io/the-openroad-project/openroad-mcp:latest
```

---

## Configuration

The server reads configuration from environment variables. Key variables:

| variable | default | description |
|---|---|---|
| `OPENROAD_MAX_SESSIONS` | `50` | Maximum concurrent sessions |
| `OPENROAD_COMMAND_TIMEOUT` | `30.0` | Default per-command timeout in seconds |
| `ORFS_FLOW_PATH` | `~/OpenROAD-flow-scripts/flow` | Path to ORFS flow directory |
| `OPENROAD_WHITELIST_ENABLED` | `true` | Enable Tcl command whitelist |

Full list: [docs/SECURITY.md#environment-variable-reference](https://github.com/The-OpenROAD-Project/openroad-mcp/blob/main/docs/SECURITY.md#environment-variable-reference)

---

## Contributing

See [CONTRIBUTING.md](https://github.com/The-OpenROAD-Project/openroad-mcp/blob/main/CONTRIBUTING.md).

---

## License

BSD 3-Clause. See [LICENSE](https://github.com/The-OpenROAD-Project/openroad-mcp/blob/main/LICENSE).
