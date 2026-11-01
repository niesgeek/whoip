.PHONY: help dev build docker docker-run test cover lint fmt vet ci clean deploy-vercel

BINARY_NAME=who-dat
VERSION?=2.0.0

help: ## Show this help message
	@echo "Who-Dat Build System"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

dev: ## Run the server with live reload-free go run
	go run ./cmd/server

build: ## Build the standalone server binary (frontend is embedded)
	@mkdir -p bin
	CGO_ENABLED=0 go build -ldflags="-w -s" -o bin/$(BINARY_NAME) ./cmd/server

docker: ## Build the Docker image
	docker build -t $(BINARY_NAME):$(VERSION) -t $(BINARY_NAME):latest .

docker-run: docker ## Build and run the Docker image
	docker run --rm -p 8080:8080 $(BINARY_NAME):latest

test: ## Run all tests
	go test ./...

tldcheck: ## Generate the live TLD coverage report (probes real registries)
	go run ./cmd/tldcheck -md alicia-notes/tld-coverage-report.md

cover: ## Run tests with a coverage report
	go test -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html

lint: ## Run golangci-lint if available
	@command -v golangci-lint >/dev/null 2>&1 && golangci-lint run ./... || echo "golangci-lint not installed, skipping"

fmt: ## Format Go code
	gofmt -s -w .

vet: ## Run go vet
	go vet ./...

ci: vet test ## Run CI checks

deploy-vercel: ## Deploy to Vercel (uses ./vercel.json)
	vercel --prod

clean: ## Remove build artifacts
	rm -rf bin/ coverage.out coverage.html
	go clean

.DEFAULT_GOAL := help
