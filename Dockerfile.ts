# TypeScript/Node.js image for the OpenROAD MCP server (npx distribution).
#
# Built on openroad/orfs so the OpenROAD binaries the PTY sessions drive are
# present at runtime — the same reason the Python Dockerfile uses this base.
# node-pty and sharp need a C++ toolchain during `npm ci`, so the builder
# installs python3/make/g++; the runtime stage carries only the prebuilt
# node_modules and compiled dist.

ARG ORFS_VERSION=26Q1-534-g510137693
ARG NODE_MAJOR=22

# Stage 1: builder — install Node + toolchain, build TypeScript, keep dev deps
# so the test stage can reuse this image.
FROM openroad/orfs:${ORFS_VERSION} AS builder
ARG NODE_MAJOR

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg python3 make g++ \
    && curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Manifests + postinstall script first so the dependency layer is cached
# independently of source changes. postinstall runs scripts/fix-node-pty.cjs.
COPY typescript/package.json typescript/package-lock.json ./
COPY typescript/scripts ./scripts
RUN npm ci

COPY typescript/tsconfig.json typescript/tsconfig.test.json ./
COPY typescript/src ./src
RUN npm run build

# Stage 2: prod-deps — drop dev dependencies while keeping the already-compiled
# native modules (node-pty, sharp), so the runtime image stays lean without a
# toolchain.
FROM builder AS prod-deps
RUN npm prune --omit=dev

# Stage 3: runtime
ARG ORFS_VERSION
ARG NODE_MAJOR
FROM openroad/orfs:${ORFS_VERSION} AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg \
    && curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash --uid 1000 --no-log-init appuser

WORKDIR /app

COPY --from=prod-deps --chown=appuser:appuser /app/node_modules /app/node_modules
COPY --from=builder --chown=appuser:appuser /app/dist /app/dist
COPY --chown=appuser:appuser typescript/package.json ./

LABEL io.modelcontextprotocol.server.name="io.github.the-openroad-project/openroad-mcp"

USER appuser

ENV PATH="/OpenROAD-flow-scripts/tools/install/OpenROAD/bin:/OpenROAD-flow-scripts/tools/install/yosys/bin:$PATH" \
    NODE_ENV=production \
    ORFS_FLOW_PATH=/OpenROAD-flow-scripts/flow

# Verify the entrypoint boots, the openroad binary is reachable, and the ORFS
# flow path exists. Each check reports its own cause so a failure isn't
# misattributed (A && B && C || D would blame D for any of the three).
RUN node /app/dist/main.js --help > /dev/null || (echo "ERROR: entrypoint 'node dist/main.js --help' failed" && exit 1)
RUN command -v openroad > /dev/null || (echo "ERROR: openroad binary not found on PATH" && exit 1)
RUN test -d "${ORFS_FLOW_PATH}" || (echo "ERROR: ORFS_FLOW_PATH=${ORFS_FLOW_PATH} not found" && exit 1)

ENTRYPOINT ["node", "/app/dist/main.js"]

# Stage 4: test — full dev deps + tests, runs unit and real-OpenROAD
# integration suites against the binaries in this image.
FROM builder AS test
COPY typescript/vitest.config.ts typescript/vitest.config.integration.ts typescript/vitest.config.performance.ts typescript/eslint.config.ts ./
COPY typescript/__tests__ ./__tests__
# Cross-implementation golden fixtures live at <repo>/tests/golden (sibling of
# typescript/); the golden tests locate them by walking up, so /app/tests/golden
# is found from /app/__tests__/golden.
COPY tests/golden ./tests/golden
ENV PATH="/OpenROAD-flow-scripts/tools/install/OpenROAD/bin:/OpenROAD-flow-scripts/tools/install/yosys/bin:$PATH" \
    ORFS_FLOW_PATH=/OpenROAD-flow-scripts/flow
CMD ["npm", "run", "test:all"]
