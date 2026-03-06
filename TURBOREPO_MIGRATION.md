# Turborepo Migration Plan

## Status

- Completed on 2026-03-06.
- The workspace now uses the `apps/*` + `packages/*` layout described below.
- `@memry/contracts`, `@memry/db-schema`, `@memry/shared`, and `@memry/typescript-config` are extracted workspace packages.
- Desktop compatibility shims under `apps/desktop/src/shared` are removed, and `apps/sync-server` imports workspace contracts directly.
- Root verification passed with `pnpm typecheck`, `pnpm --filter @memry/sync-server test`, and a focused desktop Vitest batch.
- This file is kept as the historical migration record for the completed move.

## Decisions

- `@memry/contracts` is one true cross-platform contracts package.
- `@memry/contracts` must be dependency-top-level:
  - No imports from `@memry/db-schema`
  - No imports from `apps/desktop`
  - No imports from `apps/sync-server`
- The workspace uses a single root `pnpm install`:
  - one root `pnpm-lock.yaml`
  - no nested `pnpm-lock.yaml`
  - no per-app `pnpm install`
  - app commands run via `pnpm --filter ...` or root Turbo scripts
- Desktop owns its own `.env*`, `build/`, config, scripts, tests, and native-module workflow.

## Target Structure

```text
memry/
├── apps/
│   ├── desktop/
│   │   ├── .env                          ← local, gitignored
│   │   ├── .env.example
│   │   ├── .env.production
│   │   ├── .env.staging
│   │   ├── build/
│   │   ├── config/
│   │   ├── scripts/
│   │   ├── tests/
│   │   ├── electron.vite.config.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── tsconfig.node.json
│   │   ├── tsconfig.web.json
│   │   └── src/
│   │       ├── main/
│   │       │   └── database/
│   │       │       ├── drizzle-data/
│   │       │       ├── drizzle-index/
│   │       │       └── queries/         ← moved from src/shared/db/queries/
│   │       ├── preload/
│   │       └── renderer/
│   └── sync-server/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vitest.config.ts
│       ├── wrangler.toml
│       ├── schema/
│       └── src/                         ← imports @memry/contracts directly
├── packages/
│   ├── contracts/
│   │   ├── src/
│   │   │   ├── ipc-channels.ts
│   │   │   ├── auth-api.ts
│   │   │   ├── sync-api.ts
│   │   │   ├── sync-payloads.ts
│   │   │   ├── ...
│   │   │   └── contract-owned enums/types moved out of db schema
│   │   ├── package.json                ← @memry/contracts
│   │   └── tsconfig.json
│   ├── db-schema/
│   │   ├── src/
│   │   │   ├── data-schema.ts
│   │   │   ├── index-schema.ts
│   │   │   └── schema/
│   │   ├── package.json                ← @memry/db-schema
│   │   └── tsconfig.json
│   ├── shared/
│   │   ├── src/
│   │   │   ├── utc.ts
│   │   │   └── file-types.ts
│   │   ├── package.json                ← @memry/shared
│   │   └── tsconfig.json
│   └── typescript-config/
│       ├── base.json
│       ├── node.json
│       ├── web.json
│       └── package.json                ← @memry/typescript-config
├── .github/
├── package.json                        ← private workspace root + turbo scripts
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── turbo.json
└── .npmrc
```

## Why This Structure

- `@memry/contracts`
  - owns all cross-platform TypeScript/Zod contracts
  - owns IPC channel constants because contracts already depend on them
  - owns shared enums/constants/types that are currently sourced from DB schema
- `@memry/db-schema`
  - owns Drizzle table definitions only
  - may depend on `@memry/contracts`
  - does not own desktop query implementations
- `@memry/shared`
  - owns pure utilities with no contract/schema coupling
- `apps/desktop`
  - owns Electron runtime code
  - owns native rebuild scripts
  - owns DB queries and migration assets
  - owns desktop `.env*` and `build/`
- `apps/sync-server`
  - becomes a normal workspace app
  - imports `@memry/contracts` directly
  - no more contract re-export stubs

## Workspace Package Manager Model

- `pnpm install` is run only once, at the repo root.
- The workspace has one lockfile: `pnpm-lock.yaml` at the repo root.
- `sync-server/pnpm-lock.yaml` is deleted and must not come back.
- Shared pnpm policy moves to the root:
  - `pnpm.overrides`
  - `pnpm.onlyBuiltDependencies`
  - hoist settings / mirrors in `.npmrc`
- App-specific commands are run through filters or root wrappers:
  - `pnpm --filter @memry/desktop dev`
  - `pnpm --filter @memry/sync-server dev`
  - `pnpm --filter @memry/desktop build`
  - `pnpm --filter @memry/sync-server deploy:staging`
- Root convenience scripts should wrap the common filtered commands and Turbo tasks.

## Phases

### Phase 0: Fix Package Boundaries Before Moving Files

- Promote contract-owned primitives out of DB schema into `@memry/contracts`:
  - `BookmarkItemTypes` / `BookmarkItemType`
  - `PropertyTypes` / `PropertyType`
  - reminder target/status enums and related TS types
  - sync clock/vector types that schema consumes
- Move `ipc-channels.ts` into the contracts package surface.
- Update schema files so `db-schema` imports from `contracts`, never the reverse.
- Decide that `src/shared/db/queries/` is desktop-local code, not package code.
- Add a guardrail for the migration:
  - `@memry/contracts` must not import from DB schema or app code

This phase is required. The current repo has contract/schema coupling that makes the old extraction plan invalid.

### Phase 1: Scaffold the Workspace

- Install `turbo` as a root dev dependency.
- Create `pnpm-workspace.yaml` with `apps/*` and `packages/*`.
- Convert the root `package.json` into a private workspace root:
  - keep Turbo/root orchestration scripts only
  - keep shared pnpm policy only
- Move the current desktop app manifest from repo root to `apps/desktop/package.json`.
- Keep `apps/sync-server/package.json`, but remove nested-install assumptions.
- Merge pnpm config from root and sync-server into the root workspace config:
  - `onlyBuiltDependencies`
  - `overrides`
  - hoist rules
  - mirror config
- Delete `sync-server/pnpm-lock.yaml`.
- Regenerate one root `pnpm-lock.yaml`.
- Create `turbo.json`.
- Add root scripts:
  - `dev`
  - `build`
  - `typecheck`
  - `test`
  - `lint`
  - `dev:desktop`
  - `dev:sync-server`

### Phase 2: Extract Packages

- Create `packages/typescript-config/` for shared tsconfig presets.
- Create `packages/contracts/` from:
  - `src/shared/contracts/`
  - `src/shared/ipc-channels.ts`
  - contract-owned enums/constants/types promoted in Phase 0
- Create `packages/db-schema/` from:
  - `src/shared/db/schema/`
- Create `packages/shared/` from:
  - `src/shared/utc.ts`
  - `src/shared/file-types.ts`
- Give each package:
  - `package.json`
  - exports map
  - `tsconfig.json` extending `@memry/typescript-config`

Package details:

- `@memry/contracts`
  - source-first TypeScript package
  - exports per module plus barrel/index
  - dependencies: `zod`
- `@memry/db-schema`
  - source-first TypeScript package
  - exports `./data-schema`, `./index-schema`, `./schema/*`
  - no `queries/*` exports in the first migration
  - dependencies: `drizzle-orm`, `@memry/contracts`
- `@memry/shared`
  - exports `./utc`, `./file-types`
- `@memry/typescript-config`
  - JSON-only package

### Phase 3: Move the Apps

- Move the Electron app into `apps/desktop/`:
  - local `.env` handling remains under `apps/desktop/`
  - `src/`
  - `config/`
  - `scripts/`
  - `tests/`
  - `build/`
  - `.env.example`
  - `.env.production`
  - `.env.staging`
  - `electron.vite.config.ts`
  - `tsconfig*.json`
- Move `sync-server/` into `apps/sync-server/`.
- Move desktop DB queries from `src/shared/db/queries/` into a desktop-local location:
  - preferred: `apps/desktop/src/main/database/queries/`
- Keep Drizzle migrations under `apps/desktop/src/main/database/drizzle-*`.
- Keep desktop build resources under `apps/desktop/build/`.
- Verify Electron dev env loading resolves `apps/desktop/.env*` in development and packaged resources in production.

### Phase 4: Rewire Imports and Path-Sensitive Tooling

- Replace desktop imports:
  - `@shared/contracts/*` → `@memry/contracts/*`
  - `@shared/ipc-channels` → `@memry/contracts/ipc-channels`
  - `@shared/db/schema/*` → `@memry/db-schema/*`
  - `@shared/db/queries/*` → desktop-local query alias/path
  - `@shared/utc` → `@memry/shared/utc`
  - `@shared/file-types` → `@memry/shared/file-types`
- Replace sync-server imports:
  - `../contracts/*` → `@memry/contracts/*`
- Remove `apps/sync-server/src/contracts/`.
- Delete obsolete contract-sync tooling:
  - `scripts/sync-contracts.sh`
  - `scripts/check-contracts.sh`
  - `scripts/contracts-manifest.txt`
- Update tsconfig references and path aliases.
- Update or consolidate Vitest config:
  - `config/vitest.config.ts`
  - `config/vitest.workspace.ts`
- Update Playwright config and helpers.
- Update path-sensitive scripts and helpers:
  - `scripts/generate-ipc-invoke-map.js`
  - `scripts/ensure-native.sh`
  - `scripts/check-cert-hashes.sh`
  - `scripts/extract-cert-hashes.ts`
  - DB seed scripts
  - test DB helpers
  - E2E fixtures
- Update:
  - `electron.vite.config.ts`
  - Drizzle config paths
  - `electron-builder` config
  - README and developer docs

### Phase 5: CI and Workflow Migration

- Update GitHub Actions path filters and working directories for:
  - `apps/desktop`
  - `apps/sync-server`
  - `packages/contracts`
  - `packages/db-schema`
  - `packages/shared`
- Remove workflows/jobs that only exist to enforce sync-server contract stubs.
- Update security audit to the single-root install model.
- Update sync-server CI and deploy jobs to use root install plus filtered commands.
- Update desktop release and E2E jobs to run through root workspace scripts.
- Decide lint ownership explicitly:
  - one root lint task covering all workspaces
  - or per-app lint tasks orchestrated by Turbo

### Phase 6: Verify

- `pnpm install` works from the repo root only.
- `pnpm --filter @memry/desktop dev` works.
- `pnpm --filter @memry/sync-server dev` works.
- `pnpm build` / `turbo build` passes.
- `pnpm typecheck` / `turbo typecheck` passes.
- `pnpm test` / `turbo test` passes.
- `pnpm lint` passes.
- `pnpm test:e2e` passes.
- desktop packaging still works
- sync-server deploy still works

## Turbo Task Model

- `dev`
  - persistent
  - uncached
  - used for desktop and sync-server only
- `build`
  - depends on `^build`
  - cacheable
  - desktop outputs include `out/**` and package artifacts
- `typecheck`
  - depends on `^typecheck`
  - cacheable
- `test`
  - cacheable where practical
  - may depend on `build` only for tasks that truly require built output
- `lint`
  - cacheable

## Risks and Mitigations

- Cross-package cycles
  - Mitigation: make `@memry/contracts` dependency-top-level before the directory move.
- DB query extraction drift
  - Mitigation: keep queries desktop-local in the first migration instead of forcing them into `@memry/db-schema`.
- Native module behavior in a workspace
  - Mitigation: centralize pnpm/native settings at root and keep rebuild scripts in `apps/desktop`.
- Desktop env/build asset path drift
  - Mitigation: move `.env*` and `build/` into `apps/desktop` and verify dev + package paths explicitly.
- Tooling path breakage
  - Mitigation: treat scripts/tests/workflows as first-class migration items, not “cleanup later”.
- Source-first package resolution issues
  - Mitigation: start source-first, but if Electron/Vitest/Wrangler do not resolve workspace TS cleanly, add a lightweight build step to the affected package instead of adding one-off aliases.
- Workspace lockfile regression
  - Mitigation: delete nested lockfiles and fail CI if a nested `pnpm-lock.yaml` is reintroduced.
