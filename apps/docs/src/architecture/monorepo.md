# Monorepo Layout

Memry is a pnpm + Turborepo monorepo. Three apps, three shared packages, one source of truth for contracts.

## Apps

| Path | Purpose | Stack |
| --- | --- | --- |
| `apps/desktop` | Electron desktop app | Electron 39, React 19, Vite, BlockNote, Yjs |
| `apps/sync-server` | Cloudflare Workers sync API | Workers + Hono, D1, R2 |
| `apps/docs` | This documentation site | VitePress 1.6 |

## Packages

| Path | Purpose |
| --- | --- |
| `packages/contracts` | Zod-typed IPC and HTTP API contracts. The single source of truth for renderer↔main and client↔server boundaries. |
| `packages/db-schema` | Drizzle ORM schemas for the data and index databases plus migration files. |
| `packages/shared` | Tiny set of shared utilities. Kept intentionally small to avoid coupling. |

## Tooling

- **Package manager**: pnpm 10.30+ (workspace-aware)
- **Task runner**: Turborepo for orchestration and caching
- **Node**: pinned via `.nvmrc` (24.x)
- **TypeScript**: strict mode across every package

## Cross-Cutting Scripts

```bash
# Dev
pnpm dev                # desktop dev (electron-vite)
pnpm dev:desktop        # desktop dev (alias)
pnpm dev:sync-server    # cloudflare worker dev

# Verify
pnpm lint               # ESLint flat config
pnpm typecheck          # TypeScript across all packages
pnpm test               # vitest (desktop + sync-server)
pnpm test:e2e           # Playwright E2E (Electron)
pnpm ipc:check          # validate renderer/main contract types
pnpm ipc:generate       # regenerate IPC invoke map

# Database
pnpm db:generate        # Drizzle schema → migration SQL
pnpm db:push            # apply migrations
pnpm db:studio          # Drizzle Studio GUI
```

## Why Turborepo

Most actions can be cached and parallelized:
- `lint`, `typecheck`, `test` per package
- Builds can fan out
- The cache is keyed on inputs, so unchanged packages are skipped

## Why pnpm

- Strict module resolution (no phantom dependencies)
- Workspace protocol (`workspace:*`) makes cross-package imports explicit
- Faster CI installs vs npm/yarn

## Boundaries

- Renderer never imports from `apps/desktop/src/main/*` and vice versa.
- Both sides import shared types from `@memry/contracts`.
- `packages/db-schema` is consumed by `apps/desktop/src/main` (data path) and indirectly by tests.
- `apps/sync-server` and `apps/desktop` only share types via `packages/contracts` — never code.
