#!/usr/bin/env bash
# =============================================================================
# setup-ubuntu.sh — Install OpenROAD-MCP dependencies on Ubuntu (24.04/26.04)
# =============================================================================
set -euo pipefail

echo "Setting up OpenROAD-MCP on Ubuntu..."

if [[ -z "${CI:-}" ]]; then
    read -r -p "This script will install system packages and project dependencies. Continue? [y/N] " response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi
fi

# build-essential is needed for node-pty and sharp's native addon builds.
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg build-essential

node_major=0
if command -v node &>/dev/null; then
    node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
    [[ "$node_major" =~ ^[0-9]+$ ]] || node_major=0
fi

# package.json declares "node": ">=22" — any major >= 22 already satisfies it,
# not only exactly 22.
if [ "$node_major" -lt 22 ]; then
    echo "Installing Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y --no-install-recommends nodejs
fi

echo "Installing project dependencies..."
(cd typescript && npm ci && npm run build)

echo ""
echo "Ubuntu setup complete."
echo ""
echo "Next steps:"
echo "  1. Install OpenROAD: https://openroad.readthedocs.io/en/latest/main/GettingStarted.html"
echo "  2. Run tests:        make test"
echo "  3. Start MCP server: npx -y openroad-mcp"
