# SmartCity — operational commands. See README.md for the clean-clone sequence.
SHELL := /bin/bash
.DEFAULT_GOAL := help
COMPOSE := docker compose

.PHONY: help doctor bootstrap models ingest index dev up down logs verify e2e smoke-live \
        backup restore backup-test contracts eval

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-12s %s\n",$$1,$$2}'

doctor: ## Check tools, resources, ports, env and provider reachability (no secrets printed)
	@scripts/doctor.sh

bootstrap: ## Idempotent setup: .env, Python/Node deps, db up, migrations (no model downloads)
	@scripts/bootstrap.sh

models: ## Pull local Ollama models (explicit: CONFIRM=1 make models; ~3.1 GB download)
	@scripts/models.sh

ingest: ## Bounded OSM ingest from OSM_SOURCE_URL: fetch, import, map layers, manifest
	@scripts/ingest.sh

index: ## Incremental embeddings index for active places (real embedding provider)
	@scripts/index.sh

dev: ## Run API (:8000) and web (:3000) locally with hot reload against compose db
	@scripts/dev.sh

up: ## Build and start db+api+web (+ ollama when AI_PROVIDER=ollama) and wait for health
	@set -a; [ -f .env ] && . ./.env; set +a; \
	if [ "$${AI_PROVIDER:-ollama}" = "ollama" ] || [ "$${EMBEDDING_PROVIDER:-ollama}" = "ollama" ]; then \
	  $(COMPOSE) --profile ollama up -d --build --wait db ollama api web; \
	else $(COMPOSE) up -d --build --wait db api web; fi

down: ## Stop containers incl. the ollama profile (volumes are kept)
	$(COMPOSE) --profile ollama down

logs: ## Follow container logs
	$(COMPOSE) logs -f --tail=100

verify: ## Lint, typecheck, unit/integration, build, deterministic E2E (nonzero on failure)
	@scripts/verify.sh

e2e: ## Deterministic browser E2E only
	@cd apps/web && pnpm test:e2e

smoke-live: ## Live smoke with real data + real LLM/embeddings against the running stack
	@scripts/smoke_live.sh

eval: ## Run the labelled query evaluation (dev + holdout) against the running API
	@uv run python scripts/eval_queries.py

contracts: ## Regenerate packages/contracts/openapi.json from the API models
	@uv run python -m smartcity_api.export_openapi

backup: ## Dump the database to data/backups/
	@scripts/backup.sh

restore: ## Restore BACKUP=path into a NEW database (FORCE=1 to replace smartcity, after auto-backup)
	@scripts/restore.sh "$(BACKUP)"

backup-test: ## Backup, restore into a scratch DB, compare row counts, drop scratch DB
	@scripts/backup_test.sh
