# Cross-Platform Guide — OpenROAD MCP

The server runs on **Ubuntu 22.04+**, **Ubuntu 24.04**, and **macOS 14+**. Because this MCP server depends on native C++ modules (`node-pty` for terminal sessions and `sharp` for image processing), you must have a C++ toolchain installed to build it from source.

This guide covers Node.js setup, native module build requirements, and known platform-specific issues.

---

## Requirements (all platforms)

- **Node.js 22+** — the server's `engines` field enforces this
- **npm** — bundled with Node
- **OpenROAD** on your `PATH` — for interactive session tools
- **OpenROAD-flow-scripts (ORFS)** — for report image tools (optional)

---

## Ubuntu 22.04 / 24.04

### Install Node.js 22

```bash
# NodeSource one-line installer
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # should print v22.x.x
```

### Build Requirements

`node-pty` and `sharp` compile native C++ code during `npm ci`. Install the toolchain first:

```bash
sudo apt-get install -y build-essential python3 libvips-dev
```

### Run the Server

```bash
npx -y openroad-mcp --help
```

---

## macOS 14 (Apple Silicon / Intel)

### Install Node.js 22

```bash
brew install node@22
# or via nvm:
nvm install 22 && nvm use 22
node --version
```

### Build Requirements

Xcode Command Line Tools provide the necessary C++ compiler. Install them once:

```bash
xcode-select --install
```

*Note: `sharp` uses libvips. On Apple Silicon it builds from source; on Intel a pre-built binary is usually available. Both work with Node 22.*

### Known Issues

| Issue | Workaround |
|-------|------------|
| OpenROAD is not on `PATH` after Homebrew install | Add `/opt/homebrew/bin` to your shell's `PATH`, or set `OPENROAD_ALLOWED_COMMANDS=openroad` and use the full path in your session config. |
| `node-pty` rebuild fails after a Node upgrade | `cd typescript && npm rebuild` |
| `sharp` fails with "dyld: Library not loaded" | `cd typescript && npm rebuild --update-binary` |

---

## Docker (All Platforms)

If you don't want to install Node.js, C++ toolchains, or OpenROAD locally, you can use the official Docker image.

```bash
docker run --rm -i ghcr.io/the-openroad-project/openroad-mcp:latest --help
```

**MCP Client Config:**
```json
{
  "command": "docker",
  "args": ["run", "--rm", "-i", "ghcr.io/the-openroad-project/openroad-mcp:latest"]
}
```

**Using ORFS with Docker:**
To use report image tools, mount your local ORFS flow directory:
```bash
docker run --rm -i \
  -v /your/orfs/flow:/flow:ro \
  -e ORFS_FLOW_PATH=/flow \
  ghcr.io/the-openroad-project/openroad-mcp:latest
```

---

## Troubleshooting Native Modules

If `node-pty` or `sharp` fail to load at runtime (often caused by upgrading Node.js after installing the server), rebuild them:

```bash
cd typescript
npm rebuild          # recompile against the current Node version
node dist/main.js --help   # smoke-check
```

If `npm rebuild` fails, verify your build toolchain is installed (see platform sections above) and that your Node version matches the one in the error message.
