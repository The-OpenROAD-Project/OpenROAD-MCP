#!/usr/bin/env bash
# =============================================================================
# setup-macos.sh — Install OpenROAD-MCP dependencies on macOS
# =============================================================================
set -euo pipefail

echo "🔧 Setting up OpenROAD-MCP on macOS..."

if [[ -z "${CI:-}" ]]; then
    read -r -p "This script will install uv and project dependencies. Continue? [y/N] " response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi
fi

if ! command -v uv &>/dev/null; then
    echo "📦 Installing uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
fi

echo "📦 Installing project dependencies..."
(cd python && uv sync --all-extras --inexact)

echo ""
echo "✅ macOS setup complete!"
echo ""
echo "Next steps:"
echo "  1. Install OpenROAD (optional, for full flows):"
echo "     See: https://openroad.readthedocs.io/en/latest/main/GettingStarted.html"
echo "  2. Or use Docker:    docker run --rm -i ghcr.io/the-openroad-project/openroad-mcp:latest"
echo "  3. Run tests:        make test"
echo "  4. Start MCP server: npx -y openroad-mcp"
