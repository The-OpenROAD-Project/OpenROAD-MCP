# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-07-25

### Added
- TypeScript/Node.js implementation published to npm, installable via `npx -y openroad-mcp` alongside the existing `uvx` distribution. Requires Node.js 22+.
- Cross-implementation golden-file schema-parity tests (`python/tests/golden/`) asserting the TypeScript wire output and tool manifest match the Python contract.
- Real-OpenROAD REPL integration tests validating completion detection, prompt/ANSI stripping, large-output buffering, and liveness on process exit.

### Fixed
- TypeScript session info now always serializes `error: null`, matching the Python wire contract.

## [0.5.5] - 2026-06-09

### Fixed
- Switch PyPI publish workflow to `pypi1` trusted publishing environment

## [0.5.4] - 2026-06-09

### Changed
- Migrated all repository references from luarss to The-OpenROAD-Project org ([#120](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/120))

### Fixed
- Upgraded urllib3 2.6.3 → 2.7.0 (CVE: sensitive header forwarding)

## [0.5.3] - 2026-06-06

### Changed
- Expanded coding agent documentation: added Goose, Cody, Codex CLI, PearAI, CodeBuddy, Hermes Agent, GitHub Copilot CLI, Oh My Pi, OpenClaw, AstrBot, DeepCode, nanobot, Crush, and Reasonix to README
- Added cross-platform CI validation ([#89](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/89))
- Pinned GitHub Actions to full commit SHAs for supply chain safety
- Removed editor MCP manifest files from repository
- Bumped starlette ([#117](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/117)) and idna ([#115](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/115)) dependencies

## [0.5.2] - 2026-05-17

### Fixed
- Release workflow: auto-update server.json version from git tag, fix bash -e swallowing mcp-publisher error output

## [0.5.1] - 2026-05-17

### Fixed
- Release workflow: handle duplicate MCP Registry version gracefully on re-runs

## [0.5.0] - 2026-05-17

### Added
- MCP integrations for Claude Desktop, Cursor, and GitHub Copilot ([#44](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/44))
- Documentation for MCP support across 14 major coding agents and IDEs

### Fixed
- Security: bumped authlib, python-multipart, and cryptography for CVEs
- Restored inline error patterns, dropped auto-update machinery

### Changed
- Pinned all direct dependencies to exact versions ([#113](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/113))
- Bumped fastmcp ([#101](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/101)), pillow ([#104](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/104)), cryptography ([#103](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/103)), pygments, and python-multipart ([#106](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/106), [#110](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/110))

## [0.4.2] - 2026-03-29

### Fixed
- Docker build targeting wrong stage, causing missing OCI annotation required by MCP registry
- Docker image tag mismatch causing MCP registry publish to fail

## [0.4.0] - 2026-03-29

### Added
- MCP registry publishing to release pipeline ([#93](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/93))
- Cross-platform validation and setup scripts ([#76](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/76))
- Comprehensive performance benchmarks for OpenROAD tool calls ([#84](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/84))

### Changed
- Consolidated Dockerfile.test into unified multi-stage Dockerfile ([#88](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/88))
- Scaled concurrent session test to 50+ with p99/p95 latency metrics ([#86](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/86))
- Updated ROADMAP.md
- Bumped requests dependency version

## [0.3.0] - 2026-03-25

### Added
- Production Dockerfile with multi-stage build, non-root user, and GHCR publishing workflow ([#46](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/46))
- `--init` flag to docker run commands in Makefile for proper signal handling ([#80](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/80))

### Fixed
- Restored 15 skipped TestSessionManager tests ([#75](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/75))
- Replaced `cleanup()` with `cleanup_all()` in test_session_manager ([#73](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/73))

### Changed
- Removed dead `skip_fd_issues` marker and unused imports from test_interactive_pty.py ([#82](https://github.com/The-OpenROAD-Project/openroad-mcp/pull/82))

## [0.2.0] - 2026-03-18

### Added
- `streamable-http` transport mode support in the CLI (#54)
- Whitelist and ask-permission commands for session access control (#36)
- Token efficiency benchmarks for MCP responses (#53)

### Changed
- Upgraded dependencies to address Dependabot security alerts (#70, #71)
- Updated inspector version in Makefile
- Updated Gemini MCP settings

### Refactored
- Reduced dead code and duplications across the codebase (#59)

## [0.1.0] - 2026-02-19

### Added
- Interactive PTY-based OpenROAD sessions with true terminal emulation
- Multi-session management with async support
- `interactive_openroad` tool for executing commands in persistent sessions
- `list_interactive_sessions`, `create_interactive_session`, `terminate_interactive_session`, `inspect_interactive_session`, `get_session_history`, `get_session_metrics` session lifecycle tools
- Report image tool for retrieving ORFS stage output images (#23)
- CLI entry point (`openroad-mcp`) with `--help` and version flags
- Gemini CLI integration and documentation
- Claude Code devcontainer support (#34)
- GCD timing optimization example flow targeting WNS (#35)
- Path traversal and security protection for file access
- ANSI/Unicode output decoding for clean command results
- Codecov test analytics integration
- QUICKSTART guide, ARCHITECTURE, and CONTRIBUTING documentation
- ROADMAP for planned features

[0.6.0]: https://github.com/The-OpenROAD-Project/openroad-mcp/releases/tag/v0.6.0
[0.5.5]: https://github.com/The-OpenROAD-Project/openroad-mcp/releases/tag/v0.5.5
[0.5.4]: https://github.com/The-OpenROAD-Project/openroad-mcp/releases/tag/v0.5.4
[0.5.3]: https://github.com/The-OpenROAD-Project/openroad-mcp/releases/tag/v0.5.3
[0.5.0]: https://github.com/The-OpenROAD-Project/openroad-mcp/releases/tag/v0.5.0
[0.4.2]: https://github.com/The-OpenROAD-Project/openroad-mcp/releases/tag/v0.4.2
[0.4.1]: https://github.com/The-OpenROAD-Project/openroad-mcp/releases/tag/v0.4.1
[0.4.0]: https://github.com/The-OpenROAD-Project/openroad-mcp/releases/tag/v0.4.0
[0.3.0]: https://github.com/The-OpenROAD-Project/openroad-mcp/releases/tag/v0.3.0
[0.2.0]: https://github.com/The-OpenROAD-Project/openroad-mcp/releases/tag/v0.2.0
[0.1.0]: https://github.com/The-OpenROAD-Project/openroad-mcp/releases/tag/v0.1.0
