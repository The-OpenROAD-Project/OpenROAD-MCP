# OpenROAD MCP Roadmap

This roadmap describes the development path from v0.6 to v1.0 and beyond.

## Current Status: v0.6.x — TypeScript-primary

The npm distribution (`npx openroad-mcp`) is the actively maintained release. The Python/PyPI
distribution is deprecated and will be removed from the repository in a future release.

### What ships today

- Interactive OpenROAD sessions with PTY support (`node-pty`)
- Session management — create, list, inspect, terminate
- Command history and performance metrics
- Report image listing and base64 delivery (`.webp`, auto-compressed with sharp)
- Three-tier Tcl command whitelist (see [docs/SECURITY.md](docs/SECURITY.md))
- `stdio` and Streamable HTTP transports
- Docker image on GHCR (`ghcr.io/the-openroad-project/openroad-mcp:latest`)
- 30+ MCP client configurations documented

---

## On the path to v1.0

| item | status |
|---|---|
| Docs match code — tool names, install, Docker, security | ✅ this branch |
| npm/npx primary everywhere | ✅ this branch |
| Single Dockerfile (TypeScript image) | ✅ this branch |
| Python CI removed, TypeScript CI as gate | ✅ this branch |
| Real-flow checklist executed (ORFS + AutoTuner comparison) | ⏳ needs runs with Chaitanya |
| MCP tool signatures frozen | ⏳ |
| API reference reviewed and approved | ⏳ |

**v1.0.0 will be tagged after the real-flow checklist in [docs/TESTING.md](docs/TESTING.md) is
executed and the AutoTuner comparison is filled in.**

---

## Post v1.0 ideas

These are tracked as issues and will be scheduled based on community priority:

- **Session persistence across restarts** (#57)
- **Flow orchestration** — run complete RTL-to-GDS flows through MCP
- **Design space exploration** — parameter sweeps and optimization loops
- **Real-time monitoring** — stream OpenROAD metrics during long runs
- **Checkpoint management** — save/restore design state
- **Authentication for the HTTP transport**
- **Per-command whitelist granularity** (#55)
- **Jupyter notebook support**

---

## Version history

| version | date | highlights |
|---------|------|------------|
| v0.1.0 | 2026-02-19 | PTY sessions, session management, report images, CLI, Gemini integration |
| v0.2.0 | 2026-03-18 | HTTP transport, whitelist/permissions, token efficiency benchmarks |
| v0.3.0 | 2026-03-25 | Production Dockerfile, GHCR publishing, restored test coverage |
| v0.4.0 | 2026-03-29 | MCP registry publishing, cross-platform CI, performance benchmarks |
| v0.5.3 | 2026-06-06 | Expanded client docs (14+ clients), cross-platform CI, dependency bumps |
| v0.5.4 | 2026-06-09 | Org migration to The-OpenROAD-Project, urllib3 CVE fix |
| v0.5.5 | 2026-06-09 | PyPI trusted publishing, final Python release |
| v0.6.x | 2026-Q3 | TypeScript primary, npx install everywhere, single Dockerfile, CI swap |

---

## How to contribute

See [CONTRIBUTING.md](CONTRIBUTING.md) for the Node/vitest workflow.

- **Bug reports and feature requests:** [GitHub Issues](https://github.com/The-OpenROAD-Project/openroad-mcp/issues)
- **Discussion:** [GitHub Discussions](https://github.com/The-OpenROAD-Project/openroad-mcp/discussions)

---

*Last updated: 2026-08-03*
