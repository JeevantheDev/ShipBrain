# ShipBrain Makefile
# ===================
# Helpful commands for development and deployment

.PHONY: help dev build start lint test reset-db reset-sandbox reset-all deploy

# Default target
help:
	@echo "ShipBrain Development Commands"
	@echo "=============================="
	@echo ""
	@echo "Development:"
	@echo "  make dev              - Start development server (port 3003)"
	@echo "  make build            - Build the application"
	@echo "  make start            - Start production server"
	@echo "  make lint             - Run linter"
	@echo "  make test             - Run all tests"
	@echo ""
	@echo "Database:"
	@echo "  make reset-db         - Reset app data (keeps auth users)"
	@echo "  make reset-db-full    - Reset all data including auth users"
	@echo "  make migrate          - Apply database migrations"
	@echo "  make migrate-status   - Check migration status"
	@echo ""
	@echo "Sandbox Repo:"
	@echo "  make reset-sandbox    - Reset sandbox repo (branches, tags, files)"
	@echo ""
	@echo "Full Reset (for testing onboarding):"
	@echo "  make reset-all        - Reset database + sandbox repo"
	@echo ""
	@echo "Production:"
	@echo "  make prod-build       - Build for production (with lint)"
	@echo "  make prod-deploy      - Full production deployment"

# Development
dev:
	npm run dev

build:
	npm run build

start:
	npm run start

lint:
	npm run lint

test:
	npm run test

# Database operations
reset-db:
	npm run db:reset-app

reset-db-full:
	npm run db:reset-full

migrate:
	npm run migrate:apply

migrate-status:
	npm run migrate:status

# Sandbox repo operations
reset-sandbox:
	node scripts/reset-sandbox-repo.mjs

# Full reset for testing onboarding from scratch
reset-all: reset-db-full reset-sandbox
	@echo ""
	@echo "============================================"
	@echo "Full reset complete!"
	@echo "- Database truncated and auth users deleted"
	@echo "- Sandbox repo reset to clean main branch"
	@echo "============================================"
	@echo ""
	@echo "You can now test onboarding from scratch."

# Production
prod-build:
	npm run prod:build

prod-deploy:
	npm run prod:deploy
