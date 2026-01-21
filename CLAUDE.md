# AGENTS.md

Memry is an Electron desktop app for personal knowledge management (tasks, journals, notes).

## Quick Reference

```bash
pnpm dev          # Start dev server
pnpm typecheck    # Check all TypeScript
pnpm lint         # ESLint
pnpm test         # Run all tests
pnpm vitest <path> # Single test file
```

## Architecture

3 processes: Main (Node.js) → Preload (bridge) → Renderer (React 19, no Node.js)

Two SQLite databases: `data.db` (source of truth), `index.db` (rebuildable cache)

## Guides

| Topic | Guide |
|-------|-------|
| Process model, state, components | [Architecture](.agent/architecture.md) |
| TypeScript, React, naming | [Code Style](.agent/code-style.md) |
| Test structure, utilities, mocking | [Testing](.agent/testing.md) |
| IPC handlers, contracts, validation | [IPC Patterns](.agent/ipc-patterns.md) |
| Drizzle ORM, schemas, migrations | [Database](.agent/database.md) |
| Things to avoid | [Anti-patterns](.agent/anti-patterns.md) |

## Path Aliases

```
@/       → src/renderer/src/
@shared/ → src/shared/
@renderer/ → src/renderer/src/
@tests/  → tests/
```
