# Monorepo Layout

memrynote is a pnpm + Turborepo monorepo. Apps live under `apps/`, reusable domain and storage code lives under `packages/`, and contracts remain the source of truth for app boundaries.

## Apps

| Path               | Purpose                                                       | Stack                                       |
| ------------------ | ------------------------------------------------------------- | ------------------------------------------- |
| `apps/cli`         | `memry` CLI used by desktop headless mode and standalone runs | Node 24, TypeScript                         |
| `apps/desktop`     | Electron desktop app                                          | Electron 39, React 19, Vite, BlockNote, Yjs |
| `apps/sync-server` | Cloudflare Workers sync API                                   | Workers + Hono, D1, R2                      |
| `apps/docs`        | This documentation site                                       | VitePress 1.6                               |

## Packages

| Path                 | Purpose                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/app-core`  | Shared vault-opening and command services used by non-renderer clients such as the CLI.                          |
| `packages/contracts` | Zod-typed IPC and HTTP API contracts. The single source of truth for renderer↔main and client↔server boundaries. |
| `packages/db-schema` | Drizzle ORM schemas for the data and index databases plus migration files.                                       |
| `packages/storage-*` | Shared persistence adapters for local vault files and local data database access.                                |
| `packages/domain-*`  | UI-agnostic domain command/query logic.                                                                          |
| `packages/shared`    | Tiny set of shared utilities. Kept intentionally small to avoid coupling.                                        |

## Shared Assets

Reusable brand files live in `assets/brand/memry`. The desktop icon generator reads
`assets/brand/memry/icon-color.png` and writes the packaged app icons under
`apps/desktop/build/`. It also writes the square, depth-treated social profile image under
`assets/brand/memry/social/profile-image.png`, while landing and social surfaces should reuse the
shared logo and icon sources instead of keeping app-local copies.

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
pnpm test:cli           # app-core + CLI node tests

# Verify
pnpm lint               # ESLint flat config
pnpm typecheck          # TypeScript across apps/packages
pnpm test               # app-core, CLI, desktop, and sync-server tests
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
- `packages/app-core` owns non-UI vault operations for standalone clients. Keep Electron-only concerns in `apps/desktop`; desktop `--cli` mode should call the CLI/app-core path and inject desktop vault selection state rather than duplicate command logic.
- `packages/db-schema` is consumed by desktop main, app-core, and tests.
- `apps/sync-server` and `apps/desktop` only share types via `packages/contracts` — never code.
