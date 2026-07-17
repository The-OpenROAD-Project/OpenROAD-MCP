# Contributing to OpenROAD MCP

Thank you for your interest in contributing to OpenROAD MCP! This document provides guidelines and instructions for contributing to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Code Standards](#code-standards)
- [Testing](#testing)
- [Submitting Changes](#submitting-changes)
- [MCP-Specific Guidelines](#mcp-specific-guidelines)

## Code of Conduct

We are committed to providing a welcoming and inclusive environment. Please be respectful and professional in all interactions.

## Getting Started

### Prerequisites

- Python 3.13 or higher
- [uv](https://github.com/astral-sh/uv) package manager
- OpenROAD installed on your system
- Git for version control

### Initial Setup

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/your-username/openroad-mcp.git
   cd openroad-mcp
   ```

3. Set up the development environment:
   ```bash
   uv venv
   make sync
   ```

4. Install pre-commit hooks:
   ```bash
   uv run pre-commit install
   ```

## Development Workflow

### Development Process

1. Create a new branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes following our [Code Standards](#code-standards)

3. Write tests for your changes

4. Run the test suite:
   ```bash
   make test
   ```

5. Format and lint your code:
   ```bash
   make format
   make check
   ```

6. Commit your changes with clear, descriptive commit messages

## Testing

### Test Structure

- Unit tests in `python/tests/` for individual components
- Integration tests in `python/tests/integration/` for full workflows
- Interactive PTY tests in `python/tests/interactive/`
- Performance tests in `python/tests/performance/`

### Running Tests

```bash
make test                # Run core tests (recommended)
make test-interactive    # Run PTY tests in Docker
make test-integration    # Run integration tests
make test-performance    # Run performance benchmarks
make test-coverage       # Generate coverage reports
make test-all           # Run all tests
```

### Writing Tests

- Use pytest with async support
- Write clear, focused test cases
- Include both positive and negative test cases
- Mock external dependencies when appropriate
- Aim for high code coverage

## Submitting Changes

### Pull Request Process

1. Ensure all tests pass and code is formatted:
   ```bash
   make test
   make check
   ```

2. Update documentation if needed

3. Push your branch to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```

4. Create a Pull Request on GitHub:
   - Provide a clear title and description
   - Reference any related issues or tickets
   - Include test results if applicable
   - Request review from maintainers

### Pull Request Guidelines

- Keep PRs focused on a single feature or fix
- Include tests for new functionality
- Update relevant documentation
- Ensure CI checks pass
- Respond to review feedback promptly

### Commit Messages

Write clear, descriptive commit messages:

```
Add timing checkpoint functionality

- Implement checkpoint creation with delta compression
- Add restore capability for timing data
- Include tests for checkpoint/restore cycle

Fixes #123
```

## MCP-Specific Guidelines

### Tool Implementation

All MCP tools should:

1. Inherit from appropriate base classes
2. Include comprehensive type hints
3. Return structured results
4. Handle errors gracefully
5. Include clear docstrings

### Testing MCP Tools

Use the MCP Inspector for manual testing:

```bash
make inspect
```

This launches the MCP Inspector UI for interactive testing of tools.

## Additional Resources

- [FastMCP Documentation](https://github.com/jlowin/fastmcp)
- [Model Context Protocol Specification](https://spec.modelcontextprotocol.io/)
- [OpenROAD Documentation](https://openroad.readthedocs.io/)

## License

By contributing to OpenROAD MCP, you agree that your contributions will be licensed under the project's license (TBD).

---

Thank you for contributing to OpenROAD MCP! Your efforts help make this project better for everyone.
