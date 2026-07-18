# Cross-Platform Guide — OpenROAD MCP

OpenROAD-MCP supports **Ubuntu** and **macOS**. This guide covers setup and known issues for each.

---

## Ubuntu (22.04 / 24.04)

### Automated Setup

```bash
./scripts/setup-ubuntu.sh
```

### Manual Steps

```bash
# Install system dependencies
sudo apt-get update
sudo apt-get install -y python3 python3-dev build-essential curl

# Install uv
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"

# Install OpenROAD (for integration tests)
# See: https://openroad.readthedocs.io/en/latest/main/GettingStarted.html

# Sync project (pyproject lives under python/)
(cd python && uv sync --all-extras --inexact)
make test
```

---

## macOS

### Automated Setup

```bash
./scripts/setup-macos.sh
```

### Known Issues

| Issue | Workaround |
|-------|-----------|
| OpenROAD not available via Homebrew | Use Docker: `docker compose up openroad-mcp` |
| PTY tests flaky on macOS CI | Run `make test` (core only); PTY tests are optional |
| `libomp` not found | `brew install libomp` |

---

For testing commands and MCP client compatibility, see the main [README.md](../README.md).
