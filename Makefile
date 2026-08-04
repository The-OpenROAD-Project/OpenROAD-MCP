MCP_SERVER_REQUEST_TIMEOUT := 99999999999
MCP_REQUEST_MAX_TOTAL_TIMEOUT := 99999999999
ORFS_VERSION := 26Q1-534-g510137693
IMAGE_NAME := ghcr.io/the-openroad-project/openroad-mcp

# Build the Docker image (TypeScript / Node.js distribution)
.PHONY: build
build:
	@docker build --target runtime \
		--build-arg ORFS_VERSION=$(ORFS_VERSION) \
		-t $(IMAGE_NAME):$(ORFS_VERSION) .

# TypeScript: install
.PHONY: install
install:
	@cd typescript && npm ci

# TypeScript: compile
.PHONY: ts-build
ts-build:
	@cd typescript && npm run build

# TypeScript: type check + lint
.PHONY: check
check:
	@cd typescript && npm run typecheck
	@cd typescript && npm run lint

# TypeScript: unit tests
.PHONY: test
test:
	@cd typescript && npm run test

# TypeScript: unit tests with coverage
.PHONY: test-coverage
test-coverage:
	@cd typescript && npm run test:coverage

# TypeScript: integration tests
.PHONY: test-integration
test-integration:
	@cd typescript && npm run test:integration

# TypeScript: performance benchmarks
.PHONY: test-performance
test-performance:
	@cd typescript && npm run test:performance

# TypeScript: all suites
.PHONY: test-all
test-all:
	@cd typescript && npm run test:all

# Regenerate golden wire-format fixtures
.PHONY: golden
golden:
	@echo "Regenerating golden fixtures..."
	@cd typescript && npm run generate:golden

# MCP Inspector (stdio transport)
.PHONY: inspect
inspect:
	@MCP_SERVER_REQUEST_TIMEOUT=$(MCP_SERVER_REQUEST_TIMEOUT) \
		MCP_REQUEST_MAX_TOTAL_TIMEOUT=$(MCP_REQUEST_MAX_TOTAL_TIMEOUT) \
		npx @modelcontextprotocol/inspector@0.19.0 \
		node typescript/dist/main.js

# Print any Makefile variable: make print-IMAGE_NAME
print-%:
	@echo $($*)
