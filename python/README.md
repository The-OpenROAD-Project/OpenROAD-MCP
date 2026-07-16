# OpenROAD MCP Server (Python distribution)

A Model Context Protocol (MCP) server that provides tools for interacting with
OpenROAD and ORFS (OpenROAD Flow Scripts).

This is the **Python** distribution, published to PyPI and runnable with `uvx`. It is
one of two interchangeable distributions of `openroad-mcp` — the other is the Node.js
distribution published to npm and runnable with `npx`. Both expose identical tools and
behavior; pick the one that matches your installed runtime.

For the full feature list, client support matrix, configuration examples, and
architecture docs, see the [main project README](../README.md) and the
[Quick Start guide](../QUICKSTART.md).

## Requirements

- **OpenROAD** installed and available in your PATH
  ([installation guide](https://openroad.readthedocs.io/en/latest/main/GettingStarted.html))
- **OpenROAD-flow-scripts (ORFS)** for complete RTL-to-GDS flows (optional but recommended)
- **Python 3.13+** and the [`uv`](https://astral.sh/uv) package manager
  - Install uv: `curl -LsSf https://astral.sh/uv/install.sh | sh`

## Configuration (uvx)

```json
{
  "mcpServers": {
    "openroad-mcp": {
      "command": "uvx",
      "args": [
        "--from",
        "git+https://github.com/The-OpenROAD-Project/openroad-mcp@v0.5.5#subdirectory=python",
        "openroad-mcp"
      ]
    }
  }
}
```

The pinned `@v0.5.5` suffix is recommended for supply-chain safety; drop it to track the
latest release.

## Local development

This package lives under `python/` in the repository. From the repo root:

```bash
cd python
uv sync --all-extras --inexact
uv run openroad-mcp --help
```

Common tasks are wired through the root `Makefile` (`make check`, `make test`,
`make test-tools`, ...). See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full workflow.
