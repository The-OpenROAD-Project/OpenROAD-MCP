ARG ORFS_VERSION=26Q1-534-g510137693
ARG UV_VERSION=0.10.9

FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

# Stage 1: builder - installs deps, discarded from final image.
# Both stages share openroad/orfs because OpenROAD binaries are needed at runtime.
FROM openroad/orfs:${ORFS_VERSION} AS builder

COPY --from=uv /uv /usr/local/bin/uv

ENV UV_PYTHON_INSTALL_DIR=/opt/python

WORKDIR /app

# Manifests first — dependency layer is cached independently of source changes.
COPY python/pyproject.toml python/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# --no-editable installs into site-packages; source tree not needed at runtime.
COPY python/src/ ./src/
COPY python/README.md ./
RUN uv sync --frozen --no-dev --no-editable


# Stage 2: runtime
# Re-declare without defaults — values are inherited from the global ARGs above.
ARG ORFS_VERSION
FROM openroad/orfs:${ORFS_VERSION} AS runtime

RUN useradd --create-home --shell /bin/bash --uid 1000 --no-log-init appuser

WORKDIR /app

COPY --from=builder --chown=appuser:appuser /app/.venv /app/.venv
COPY --from=builder --chown=appuser:appuser /opt/python /opt/python

LABEL io.modelcontextprotocol.server.name="io.github.luarss/openroad-mcp"

USER appuser

ENV PATH="/app/.venv/bin:/OpenROAD-flow-scripts/tools/install/OpenROAD/bin:/OpenROAD-flow-scripts/tools/install/yosys/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    ORFS_FLOW_PATH=/OpenROAD-flow-scripts/flow

# Verify non-editable install, console script, and ORFS path are all functional.
RUN /app/.venv/bin/python -c "import openroad_mcp; print(openroad_mcp.__file__)" && \
    openroad-mcp --help > /dev/null && \
    test -d "${ORFS_FLOW_PATH}" || (echo "ERROR: ORFS_FLOW_PATH=${ORFS_FLOW_PATH} not found" && exit 1)

ENTRYPOINT ["openroad-mcp"]

# Stage 3: test — pinned ORFS version + uv inherited from builder
FROM builder AS test
COPY python/tests/ ./tests/
RUN uv sync --frozen --all-extras
ENV PYTHONPATH=/app/src
ENV PATH="/app/.venv/bin:/OpenROAD-flow-scripts/tools/install/OpenROAD/bin:/OpenROAD-flow-scripts/tools/install/yosys/bin:$PATH"
USER root
CMD ["bash"]
