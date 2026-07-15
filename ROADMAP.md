# OpenROAD MCP Roadmap

This roadmap outlines the development journey of OpenROAD MCP from pre-release to stable production-ready releases.

## Current Status: Pre-Release (v0.x)

We are currently in the **pre-release phase**, focusing on gathering community feedback on core functionality. The goal is to validate the basic feature set and developer experience before stabilizing the API for v1.0.

### What Works Today

- Interactive OpenROAD sessions with PTY support
- Session management (create, list, inspect, terminate)
- Command history and metrics tracking
- Report image visualization from ORFS runs
- Integration with Claude Code and Gemini CLI
- Docker deployment via GitHub Container Registry (GHCR)
- Streamable HTTP transport

### Pre-Release Goals

The pre-release phase focuses on:

1. **Community Validation** - Getting feedback from early adopters on core features
2. **Developer Experience** - Ensuring smooth installation and setup across platforms
3. **API Refinement** - Identifying pain points and edge cases before API stabilization
4. **Documentation Quality** - Building comprehensive guides based on real user questions

**Feedback Channels:**
- [GitHub Issues](https://github.com/The-OpenROAD-Project/openroad-mcp/issues) - Bug reports and feature requests
- [GitHub Discussions](https://github.com/The-OpenROAD-Project/openroad-mcp/discussions) - Questions and community discussion

---

## Phase 1: Foundation → v0.5

**Status:** In Progress
**Timeline:** Q2 2026

### Core Features
- [x] Interactive OpenROAD session support with PTY
- [x] Multi-session management
- [x] Command history tracking
- [x] Performance metrics collection
- [x] Report image visualization
- [x] Pre-built Docker image (GHCR)
- [x] Streamable HTTP transport
- [ ] Session persistence across restarts (#57)
- [ ] Configurable Docker image and CLI variables (#48)

### Developer Experience
- [x] Quick Start guide
- [x] Claude Code integration
- [x] Gemini CLI integration
- [ ] VS Code extension integration testing
- [ ] Zed integration testing
- [ ] Comprehensive troubleshooting guide
- [ ] Video tutorials - installation, basic usage (#58)

### Quality & Testing
- [x] Core test suite (80%+ coverage)
- [x] Type hints on all public APIs
- [x] Load testing (50+ concurrent sessions)
- [ ] Cross-platform validation and setup scripts (#77)
- [ ] Integration tests with real ORFS flows
- [ ] Playwright e2e testing via MCP inspector (#60)
- [ ] Performance benchmarking suite
- [ ] Memory leak detection

---

## Phase 2: Enhancement → v0.8

**Status:** Planned
**Goal:** Feature completeness and ecosystem integration

### Security & Permissions
- [x] Whitelist and ask-permission commands (v0.2.0)
- [ ] Per-command whitelist granularity (#55)
- [ ] Progressive disclosure of advanced features (#51)

### Publishing & Distribution
- [ ] Publish to MCP server registry (official, Smithery, MCPCentral) (#41)
- [ ] Skills + Anthropic plugins repository (#52)
- [x] Token efficiency benchmarks (v0.2.0)
- [ ] MCP best practices compliance (#42)

### Advanced Features
- [ ] **Flow orchestration** - Run complete RTL-to-GDS flows through MCP
- [ ] **Design space exploration** - Parameter sweeps and optimization loops
- [ ] **Real-time monitoring** - Stream OpenROAD metrics during long runs
- [ ] **Checkpoint management** - Save/restore design state
- [ ] **Multi-design support** - Work with multiple designs simultaneously
- [ ] **Resource scheduling** - Queue management for long-running jobs

### Integration & Compatibility
- [ ] Additional MCP clients (#8)
  - [ ] Cursor
  - [ ] GitHub Copilot
  - [ ] Cline
  - [ ] Roo Code
  - [ ] Goose
  - [ ] Open Code
- [ ] VS Code OpenROAD extension integration
- [ ] GUI tool integration (#16)
- [ ] CI/CD pipeline integration (GitHub Actions, GitLab CI)
- [ ] Jupyter notebook support
- [ ] Web-based interface option

### Developer Tools
- [ ] Interactive debugging tools
- [ ] OpenROAD command completion/suggestions
- [ ] Design rule check (DRC) integration
- [ ] Timing analysis visualization
- [ ] Power analysis reporting

### Performance
- [ ] Session pooling for faster command execution
- [ ] Incremental design updates
- [ ] Parallel flow execution
- [ ] Distributed computing support
- [ ] Resource usage optimization
- [ ] Improved image compression algorithm (#24)

---

## Phase 3: Stabilization → v1.0

**Status:** Future
**Goal:** Production-ready stable release

### API Stabilization
- [ ] Freeze MCP tool signatures (backward compatibility guarantee)
- [ ] Comprehensive API documentation
- [ ] Migration guides for API changes
- [ ] Deprecation policy established
- [ ] Semantic versioning commitment

### Production Features
- [ ] Comprehensive error handling and recovery
- [ ] Rate limiting and resource quotas
- [ ] Authentication/authorization framework
- [ ] Audit logging
- [ ] Multi-tenant support
- [ ] Enterprise deployment guide

### Advanced Capabilities
- [ ] Code mode support (#38)
- [ ] Guidance flow based on heat maps (#30)
- [ ] Paper references and academic documentation (#6)

### Documentation
- [ ] Complete API reference
- [ ] Architecture deep-dive
- [ ] Performance tuning guide
- [ ] Security best practices
- [ ] Case studies and examples
- [ ] Contributing guide expansion

### Quality Assurance
- [ ] 90%+ test coverage
- [ ] Zero critical bugs
- [ ] Security audit completed
- [ ] Performance benchmarks documented
- [ ] Stress testing (1000+ concurrent sessions)
- [ ] Cross-platform validation (Ubuntu, macOS, Windows/WSL2)

---

## Phase 4: Ecosystem

**Status:** Future
**Goal:** Build a thriving ecosystem around OpenROAD MCP

### Extensions & Plugins
- [ ] Plugin system for custom tools
- [ ] Community plugin marketplace
- [ ] Third-party PDK integrations
- [ ] EDA tool bridges (Yosys, ABC, etc.)
- [ ] Cloud provider integrations (AWS, GCP, Azure)

### Community
- [ ] Community showcase (projects built with OpenROAD MCP)
- [ ] Monthly community calls
- [ ] Tutorial series and workshops
- [ ] OpenROAD MCP conference talks
- [ ] Academic partnerships and research collaborations

### Advanced Capabilities
- [ ] Machine learning integration for optimization
- [ ] Design quality prediction
- [ ] Automated parameter tuning
- [ ] Historical analysis and trend tracking
- [ ] Multi-objective optimization support

---

## Version Milestones

| Version | Date | Key Deliverables |
|---------|------|------------------|
| v0.1.0 | 2026-02-19 | PTY sessions, session management, report images, CLI, Gemini integration, docs |
| v0.2.0 | 2026-03-18 | HTTP transport, whitelist/permissions, token efficiency benchmarks |
| v0.3.0 | 2026-03-25 | Production Dockerfile, GHCR publishing, restored test coverage |
| v0.4.0 | 2026-03-29 | MCP registry publishing, cross-platform CI, performance benchmarks |
| v0.5.3 | 2026-06-06 | Expanded agent docs (14+ clients), cross-platform CI, dependency bumps |
| v0.5.4 | 2026-06-09 | Org migration to The-OpenROAD-Project, urllib3 CVE fix |
| v0.5.5 | 2026-06-09 | Switch to pypi1 trusted publishing environment |
| v0.5 | Q2 2026 | Session persistence, e2e testing |
| v0.8 | Q2 2026 | MCP registry publish, multi-client support, GUI integration |
| v1.0 | Q2 2026 | API freeze, security audit, production hardening |

---

## How to Contribute

We welcome community involvement at every stage:

1. **Try it out** - Install OpenROAD MCP and provide feedback
2. **Report issues** - Help us identify bugs and rough edges
3. **Request features** - Tell us what would make your workflow better
4. **Contribute code** - See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines
5. **Write docs** - Help others by improving guides and examples
6. **Share your work** - Show us what you've built with OpenROAD MCP

---

## Feedback & Questions

- **GitHub Issues:** [Report bugs and request features](https://github.com/The-OpenROAD-Project/openroad-mcp/issues)
- **GitHub Discussions:** [Ask questions and share ideas](https://github.com/The-OpenROAD-Project/openroad-mcp/discussions)

---

**Last Updated:** 2026-03-27
**Current Phase:** Phase 1 (v0.3.x → v0.5)

*This roadmap is a living document and will evolve based on community feedback and priorities.*
