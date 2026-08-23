# Monorepo Layout

memrynote is a pnpm + Turborepo monorepo. Apps live under `apps/`, reusable domain and storage code lives under `packages/`, and contracts remain the source of truth for app boundaries.

## Apps

| Path               | Purpose                                                           | Stack                                       |
| ------------------ | ----------------------------------------------------------------- | ------------------------------------------- |
| `apps/cli`         | `memrynote` CLI used by desktop headless mode and standalone runs | Node 24, TypeScript                         |
| `apps/desktop`     | Electron desktop app                                              | Electron 43, React 19, Vite, BlockNote, Yjs |
| `apps/sync-server` | Cloudflare Workers sync API                                       | Workers + Hono, D1, R2                      |
| `apps/docs`        | This documentation site                                           | VitePress 1.6                               |

## Packages

| Path                   | Purpose                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/app-core`    | Platform-free service contracts and pure domain logic (ids, markdown, reminders, tags, …) importable by any shell, mobile included. The node-bound `createMemryApp` implementation cluster lives with its only consumer, `apps/cli/src/app-core/`. |
| `packages/sync-client` | The platform-free sync engine extraction: outbox, record sync services, vector clocks, CRDT merge/pending logic, and the ten platform adapter seams. Compiled with `types: []` so node globals cannot leak in; desktop implements the seams under `apps/desktop/src/main/sync/adapters/`. |
| `packages/contracts`   | Zod-typed IPC and HTTP API contracts. The single source of truth for renderer↔main and client↔server boundaries. |
| `packages/db-schema`   | Drizzle ORM schemas for the data and index databases plus migration files, and the driver-agnostic `DrizzleDb` type both shells share. |
| `packages/storage-*`   | Shared persistence adapters for local vault files and local data database access.                                |
| `packages/domain-*`    | UI-agnostic domain command/query logic.                                                                          |
| `packages/shared`      | Tiny set of shared utilities. Kept intentionally small to avoid coupling.                                        |

## Shared Assets

Reusable brand files live in `assets/brand/memry`. The desktop icon generator reads
`assets/brand/memry/icon-color.png` and writes the packaged app icons under
`apps/desktop/build/`; `pnpm --dir apps/desktop generate:icons` writes the default
light icons, and `pnpm --dir apps/desktop generate:icons --dark` overwrites those same
Electron icon files with the dark icon treatment. It also writes the depth-treated
social profile PNGs under
`assets/brand/memry/social/profile-image.png`,
`assets/brand/memry/social/profile-square.png`, and
`assets/brand/memry/social/profile-rectangle.png`, plus dark-theme variants at
`assets/brand/memry/social/profile-image-dark.png`,
`assets/brand/memry/social/profile-square-dark.png`, and
`assets/brand/memry/social/profile-rectangle-dark.png`, while landing and social surfaces should
reuse the shared logo and icon sources instead of keeping app-local copies.

## Tooling

- **Package manager**: pnpm 10.30+ (workspace-aware)
- **Task runner**: Turborepo for orchestration and caching
- **Node**: pinned via `.nvmrc` (24.x)
- **TypeScript**: strict mode across every package

## Desktop Runtime Dependencies

In `apps/desktop/package.json`, `dependencies` is a packaging contract, not a
convenience: electron-vite externalizes exactly those modules, and `pnpm deploy
--prod` ships them loose next to `app.asar` in the packaged app. macOS Squirrel
code-sign-verifies every loose file during auto-update, so each package in
`dependencies` slows Restart for every user. Only native or otherwise
unbundleable modules belong there (better-sqlite3, keytar, sharp, sqlite-vec,
jsdom, y-leveldb, yjs, libsodium-wrappers-sumo, @huggingface/transformers,
@mixmark-io/domino, electron-log); every pure-JS dependency lives in
`devDependencies` and is bundled into `out/` by electron-vite. electron-log is
pure JS but unbundleable: its entry selects the main/renderer/node
implementation through runtime `require()` branches, and bundling hoists all
three — including an unconditional `require('electron')` that crashes
worker_threads (the sync, image-processing, and voice-transcription workers)
in packaged builds. The exact set is asserted by
`apps/desktop/src/main/runtime-dependencies.test.ts` and re-verified against
the packaged app by `apps/desktop/scripts/check-packaged-runtime-deps.js`;
`apps/desktop/scripts/check-worker-bundles.mjs` additionally fails the build
if any worker entry's chunk graph reaches a literal `require("electron")`.
Rationale and measurements: `docs/auto-update-slow-restart-investigation.md`
in the repo root.

## Cross-Cutting Scripts

```bash
# Dev
pnpm dev                # desktop dev (electron-vite)
pnpm staging            # desktop dev pointed at staging sync
pnpm dev:desktop        # desktop dev (alias)
pnpm dev:sync-server    # cloudflare worker dev
pnpm test:cli           # app-core + CLI node tests

# Deploy
pnpm run deploy:sync:staging     # deploy staging sync worker
pnpm run deploy:sync:production  # deploy production sync worker

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

The `db:*` commands above manage the desktop's local Drizzle databases. The
`apps/sync-server` Cloudflare D1 database is separate: its schema lives in
`apps/sync-server/migrations/` as wrangler D1 migrations. The staging and
production deploy workflows run `wrangler d1 migrations apply` **before**
`wrangler deploy`, so schema changes ship with the code that depends on them.
Add a new `NNNN_*.sql` migration for any schema change and never edit an applied
one; `pnpm --filter @memry/sync-server run sync:init-db` applies them locally.

## Runtime Environments

Desktop runtime config is selected with `MEMRY_ENV`:

- `development` is the local desktop app talking to the local Wrangler sync server at
  `http://localhost:8787`.
- `staging` is the desktop staging command talking to Cloudflare staging at
  `https://sync-staging.memrynote.com`.
- `production` is reserved for packaged release builds and talks to `https://sync.memrynote.com`.

Production desktop packaging must use the production sync URL only; release builds fail if the
packaged runtime config is missing or points at localhost or staging.

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
