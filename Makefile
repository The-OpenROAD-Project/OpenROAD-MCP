MCP_SERVER_REQUEST_TIMEOUT:= 99999999999
MCP_REQUEST_MAX_TOTAL_TIMEOUT:= 99999999999
DOCKER_TEST_IMAGE:= openroad-mcp-test
ORFS_VERSION:= 26Q1-534-g510137693
UV_VERSION:= 0.10.9
IMAGE_NAME:= ghcr.io/the-openroad-project/openroad-mcp

.PHONY: sync
sync:
	@cd python && uv sync --all-extras --inexact


.PHONY: format
format:
	@cd python && uv run ruff format .
	@cd python && uv run ruff check . --fix

.PHONY: check
check:
	@cd python && uv run ruff check
	@cd python && uv run mypy .
	@uv run --project python pre-commit run --all-files

# Test targets
.PHONY: test
test:
	@echo "Running core tests..."
	@cd python && uv run pytest --ignore=tests/interactive --ignore=tests/performance --ignore=tests/integration

# Build Docker test image
.PHONY: docker-test-build
docker-test-build:
	@docker build -f Dockerfile --target test \
		--build-arg ORFS_VERSION=$(ORFS_VERSION) \
		--build-arg UV_VERSION=$(UV_VERSION) \
		-t $(DOCKER_TEST_IMAGE) .

# Build production Docker image
.PHONY: build
build:
	@docker build --target runtime \
		--build-arg ORFS_VERSION=$(ORFS_VERSION) \
		--build-arg UV_VERSION=$(UV_VERSION) \
		-t $(IMAGE_NAME):$(ORFS_VERSION) .

.PHONY: test-interactive
test-interactive: docker-test-build
	@echo "Running interactive tests..."
	@docker run --rm --init $(DOCKER_TEST_IMAGE) uv run pytest tests/interactive

.PHONY: test-integration
test-integration: docker-test-build
	@echo "Running integration tests for timing workflows..."
	@docker run --rm --init $(DOCKER_TEST_IMAGE) uv run pytest tests/integration

.PHONY: test-tools
test-tools:
	@echo "Running MCP tools tests..."
	@cd python && uv run pytest tests/tools/

.PHONY: test-performance
test-performance: docker-test-build
	@echo "Running performance tests (benchmarks, memory, stability)..."
	@docker run --rm --init $(DOCKER_TEST_IMAGE) uv run pytest tests/performance/

# TypeScript test targets (no Docker required - use bash/cat/echo from host)
.PHONY: test-ts
test-ts:
	@echo "Running TypeScript unit tests..."
	@cd typescript && npm run test

.PHONY: golden
golden:
	@echo "Regenerating golden fixtures from TypeScript models..."
	@cd typescript && npm run generate:golden

.PHONY: test-ts-integration
test-ts-integration:
	@echo "Running TypeScript integration tests..."
	@cd typescript && npm run test:integration

.PHONY: test-ts-performance
test-ts-performance:
	@echo "Running TypeScript performance tests..."
	@cd typescript && npm run test:performance

.PHONY: test-ts-all
test-ts-all:
	@echo "Running all TypeScript tests (unit + integration + performance)..."
	@cd typescript && npm run test:all

.PHONY: test-coverage
test-coverage: docker-test-build
	@echo "Running tests with coverage analysis..."
	@docker run --rm --init -v $(PWD):/output $(DOCKER_TEST_IMAGE) sh -c "\
		uv run pytest --ignore=tests/performance \
			--cov=src/openroad_mcp \
			--cov-report=xml \
			--cov-report=html \
			--cov-report=term-missing \
			--junit-xml=junit.xml && \
		cp coverage.xml /output/ && \
		cp junit.xml /output/ && \
		cp -r htmlcov /output/ 2>/dev/null || true"

# MCP
.PHONY: inspect
inspect:
	@MCP_SERVER_REQUEST_TIMEOUT=$(MCP_SERVER_REQUEST_TIMEOUT) \
		MCP_REQUEST_MAX_TOTAL_TIMEOUT=$(MCP_REQUEST_MAX_TOTAL_TIMEOUT) \
		npx @modelcontextprotocol/inspector@0.19.0 uv run --project python openroad-mcp

.PHONY: test-all
test-all:
	@echo "Running all tests (python core + interactive + tools + integration, typescript)..."
	@$(MAKE) test
	@$(MAKE) test-interactive
	@$(MAKE) test-tools
	@$(MAKE) test-integration
	@$(MAKE) test-ts-all

# Print any Makefile variable: make print-IMAGE_NAME
print-%:
	@echo $($*)
