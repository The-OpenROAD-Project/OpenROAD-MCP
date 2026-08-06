# OpenROAD MCP Server

<!-- mcp-name: io.github.The-OpenROAD-Project/openroad-mcp -->

A Model Context Protocol (MCP) server that provides tools for interacting with [OpenROAD](https://theopenroadproject.org/) and [ORFS](https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts).

## About OpenROAD MCP

**New here?** Check out the [Quick Start Guide](docs/QUICKSTART.md) to get your AI assistant analyzing designs in 5 minutes.

OpenROAD MCP eliminates the barrier between your AI assistant and physical design by connecting Claude, Cursor, and other MCP-compatible clients directly to the OpenROAD layout tools.

OpenROAD is the leading open-source, foundational application for semiconductor digital design, delivering an Autonomous, No-Human-In-Loop (NHIL) flow from RTL-GDSII. OpenROAD-flow-scripts (ORFS) is the fully autonomous flow built around it.

With this MCP server, your AI assistant can:
- **Execute Commands** - Run interactive OpenROAD sessions with full PTY support.
- **Manage Sessions** - Create, list, inspect, and terminate multiple physical design sessions.
- **Track History & Metrics** - Access full command history and performance metrics for analysis.
- **Visualize Reports** - List and read report images from ORFS runs directly in the chat.

## Demo

![OpenROAD MCP Demo](demo/video_gen/demo-quick.gif)

[Watch full demo video](https://youtu.be/UQM1otOl17s)

## Requirements & Installation

To use this MCP server, you need the server runtime, plus the underlying OpenROAD layout tools.

### 1. Server Runtime
- **Node.js 22+** is required to run the `npx` distribution.

### 2. OpenROAD
**OpenROAD** must be installed and available in your `PATH`.
- [Official OpenROAD Installation Guide](https://openroad.readthedocs.io/en/latest/user/Build.html)

### 3. OpenROAD-flow-scripts (ORFS)
**ORFS** is optional but highly recommended for complete RTL-to-GDS flows and report visualization.
- [Official ORFS Local Build Guide](https://openroad-flow-scripts.readthedocs.io/en/latest/user/BuildLocally.html)

## Configuration

For platform-specific Node.js and C++ toolchain setup instructions, see the **[Cross-Platform Build Guide](docs/CROSS_PLATFORM.md)**.

Before configuring your MCP client, you must provide the server with your local paths to OpenROAD and ORFS.

### 1. Find Your Paths
Run these commands in your terminal to locate the necessary directories:

```bash
# Get your OpenROAD binary directory:
dirname $(which openroad)

# Check for the default ORFS flow directory:
ls ~/OpenROAD-flow-scripts/flow
# (If not found, search with: find ~ -maxdepth 4 -type d -name flow -path "*/OpenROAD-flow-scripts/*" 2>/dev/null)
```

### 2. Set Up Environment Variables
Copy the example environment file and fill in the paths you just found:

```bash
cp .env.example .env
```
Edit `.env` to ensure `PATH` includes your OpenROAD binary directory, and `ORFS_FLOW_PATH` points to your ORFS checkout. Pass these values into your MCP client's configuration via the `env` block.

## Supported MCP Clients

Here is the standard base configuration used across most clients:

```json
{
  "command": "npx",
  "args": ["-y", "openroad-mcp"]
}
```

Find your specific client below for the exact configuration snippet and file location. 

*(Note: If your client supports environment variables in the config, inject your `PATH` and `ORFS_FLOW_PATH` directly in the snippet).*

<details><summary><b>Claude Code</b></summary>

```bash
claude mcp add --transport stdio openroad-mcp -- npx -y openroad-mcp
```
Or add the standard config to `.claude/settings.json`.
</details>

<details><summary><b>Claude Desktop</b></summary>

Add the standard config to:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
</details>

<details><summary><b>Cursor</b></summary>

Add the standard config to `.cursor/mcp.json`.
</details>

<details><summary><b>GitHub Copilot (VS Code)</b></summary>

Add to `.vscode/mcp.json`. Requires `"type": "stdio"`:
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
</details>

<details><summary><b>Windsurf</b></summary>

Add the standard config to `~/.codeium/windsurf/mcp_config.json`.
</details>

<details><summary><b>Cline / Roo Code</b></summary>

Add the standard config to `cline_mcp_settings.json` (Cline) or `.roo/mcp.json` (Roo Code).
</details>

<details><summary><b>Continue / PearAI</b></summary>

Add to your respective `config.json` under `modelContextProtocolServers`:
```json
{
  "transport": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "openroad-mcp"]
  }
}
```
</details>

<details><summary><b>Zed</b></summary>

Add to `~/.config/zed/settings.json`:
```json
{
  "context_servers": {
    "openroad-mcp": {
      "command": {
        "path": "npx",
        "args": ["-y", "openroad-mcp"]
      }
    }
  }
}
```
</details>

<details><summary><b>Docker / MCP Registry / Others</b></summary>

The server is available on the [MCP Registry](https://registry.modelcontextprotocol.io) and via Docker:
```bash
docker run --rm -i ghcr.io/the-openroad-project/openroad-mcp:latest
```
Most other standard STDIO clients are fully supported. Refer to your tool's MCP setup guide.
</details>

## Available Tools

Once configured, your AI assistant will have access to the following tools. For detailed parameters, schemas, and return formats, see the **[API Reference](docs/API.md)**.

- `interactive_openroad_query`
- `interactive_openroad_exec`
- `create_interactive_session`
- `list_interactive_sessions`
- `terminate_interactive_session`
- `inspect_interactive_session`
- `get_session_history`
- `get_session_metrics`
- `list_report_images`
- `read_report_image`

## Troubleshooting

- **The server fails to start**: Ensure you have Node.js 22+. Older versions will fail.
- **Session creation fails**: Confirm `openroad` is on your `PATH`. The server spawns it by name; if it's missing, session creation (not startup) will fail.
- **Commands rejected with CommandBlocked**: You sent a state-modifying command to `interactive_openroad_query`. Use `interactive_openroad_exec` instead.
- **Report images not found**: Make sure `ORFS_FLOW_PATH` points to your ORFS `flow/` directory.

To get more detail, set `LOG_LEVEL=DEBUG` in the server's environment.

## Development

Clone the repository and run:
```bash
cd typescript
npm install
npm run build
```

**Testing:**
```bash
npm run test             # unit tests
npm run test:integration # integration tests
npm run test:performance # performance benchmarks
```

**Linting & type checking:**
```bash
npm run typecheck
npm run lint
```

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for detailed instructions on our development workflow and code standards.

## License

BSD 3-Clause License. See [LICENSE](LICENSE) file.

---
*Built with ❤️ by Precision Innovations*