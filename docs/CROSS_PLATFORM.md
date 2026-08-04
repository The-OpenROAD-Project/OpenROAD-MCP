# Cross-Platform Guide — OpenROAD MCP

The server runs on **Ubuntu 22.04+**, **Ubuntu 24.04**, and **macOS 14+**. This guide covers
Node.js setup, native module build requirements, and known platform-specific issues.

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

### Build requirements for native modules

`node-pty` and `sharp` compile native C++ code at `npm ci`. Install the toolchain first:

```bash
sudo apt-get install -y build-essential python3 libvips-dev
```

### Run the server

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

### Build requirements

Xcode Command Line Tools provide the compiler. Install them once:

```bash
xcode-select --install
```

`sharp` uses libvips. On Apple Silicon it builds from source; on Intel a pre-built binary is
usually available. Both work with Node 22.

### Known issues

| issue | workaround |
|---|---|
| OpenROAD is not on `PATH` after Homebrew install | Add `/opt/homebrew/bin` to your shell's `PATH`, or set `OPENROAD_ALLOWED_COMMANDS=openroad` and use the full path in your session `command` array |
| `node-pty` rebuild fails after a Node upgrade | `cd typescript && npm rebuild` |
| `sharp` fails with "dyld: Library not loaded" | `cd typescript && npm rebuild --update-binary` |

---

## Docker (all platforms, no local OpenROAD needed)

The GHCR image includes OpenROAD and does not require it on the host:

```bash
docker run --rm -i ghcr.io/the-openroad-project/openroad-mcp:latest --help
```

MCP client config:

```json
{
  "mcpServers": {
    "openroad-mcp": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "ghcr.io/the-openroad-project/openroad-mcp:latest"]
    }
  }
}
```

Mount your ORFS flow directory to use report image tools:

```bash
docker run --rm -i \
  -v /your/orfs/flow:/flow:ro \
  -e ORFS_FLOW_PATH=/flow \
  ghcr.io/the-openroad-project/openroad-mcp:latest
```

---

## Cross-platform CI

The `cross-platform.yml` workflow validates the server on ubuntu-22.04, ubuntu-24.04, and
macos-14 on every push. It runs `npm ci`, `npm run build`, and `node dist/main.js --help` — the
checks that exercise native module compilation.

---

## Troubleshooting native modules

`node-pty` and `sharp` are the two native dependencies. If either fails to load:

```bash
cd typescript
npm rebuild          # recompile against the current Node version
node dist/main.js --help   # smoke-check
```

If `npm rebuild` itself fails, check that the build toolchain is installed (see platform sections
above) and that Node matches the version in the error message.
