# Desktop Rules

Electron desktop app (`@memry/desktop`). The reference implementation of Memry. Root `AGENTS.md` applies; this file adds desktop-specific rules.

## Layout

- `src/main` — Electron main process. Owns SQLite, Y.Docs, sync, vault I/O, keychain.
- `src/preload` — context bridge only. No logic.
- `src/renderer/src` — React UI. Never touches Node APIs directly.
- `src/shared` — code compiled into both sides. Keep it dependency-free of Electron.
- `tests/` — E2E (Playwright + Electron). `src/**/*.test.ts` — unit/integration.

## Commands

```bash
pnpm dev                 # from repo root
pnpm --filter @memry/desktop dev:a    # profile/device A (also :b, :c)
pnpm --filter @memry/desktop dev:staging
```

Verification, narrowest first:

```bash
pnpm --filter @memry/desktop typecheck:web
pnpm --filter @memry/desktop typecheck:node
pnpm --filter @memry/desktop typecheck:test
pnpm --filter @memry/desktop test:renderer
pnpm --filter @memry/desktop test:main
pnpm --filter @memry/desktop i18n:check
pnpm test:desktop
pnpm test:e2e
npx -y react-doctor@latest .
```

- Run the narrowest command that covers the change; run `pnpm test:desktop` before declaring a broad change done.
- `test:e2e` does not build the app. Playwright loads `apps/desktop/out/main/index.js`, so run `pnpm --filter @memry/desktop exec electron-vite build` after your last code change and before E2E. A fresh worktree has no `out/` and fails with `Cannot find module .../out/main/index.js`; an existing `out/` may be stale. CI builds in a separate step, which is why the build is not part of `pretest:e2e`.
- Run a single spec with `pnpm --filter @memry/desktop test:e2e <spec-name>`, once. Do not loop on E2E.
- Never run `build:release` or signing/notarization commands unless the user asks.

## Process Boundary

- All renderer<->main communication goes through `packages/contracts`. No ad-hoc `ipcRenderer.invoke` channels.
- After editing contracts, preload APIs, main IPC handlers, generated RPC bindings, or Agent Chat provider/IPC channels: `pnpm ipc:generate` then `pnpm ipc:check`.
- Main process owns Y.Docs; the renderer uses the IPC provider. Tag updates with `sourceWindowId` or you create an IPC loop.
- Sync handlers are per-type in `src/main/sync/item-handlers/`, registered via `getHandler(type)`. Add a handler, don't branch in the caller.

## Database

- Dual DB: data DB (notes, tasks, projects) and index DB (search, graph). Both better-sqlite3 via Drizzle.
- Data DB migrations are hand-written and additive. Drizzle snapshots are broken past 0021 — do not regenerate them for the data DB.
- Never reset or drop a user table. Real installs carry real data.

```bash
pnpm --filter @memry/desktop db:generate
pnpm --filter @memry/desktop db:push
pnpm --filter @memry/desktop db:studio:data
pnpm --filter @memry/desktop db:studio:index
```

## Native Modules

- Node test/script load errors: `pnpm --filter @memry/desktop rebuild:node`.
- Electron dev/E2E/build load errors: `pnpm --filter @memry/desktop rebuild:electron`.
- Neither rebuild is evidence for the other runtime.
- The EventKit helper (`native/eventkit`, macOS only) is separate from both: `pnpm --filter @memry/desktop build:eventkit`. Unit tests use a fake helper; one test also checks the protocol against the built helper when it exists on a Mac. See `native/eventkit/README.md`.

## UI

- Read `DESIGN.md` before any UI change. Live token values are in `src/renderer/src/assets/base.css`; the catalog is `docs/DESIGN_TOKENS.md`.
- Logical Tailwind properties only in new code: `ms/me`, `ps/pe`, `start/end`, `text-start/text-end`, `border-s/border-e`, `rounded-s/rounded-e`.
- All user-visible strings go through i18n. `pnpm --filter @memry/desktop i18n:check` must pass.
- User-facing errors use `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`.
- Logging uses `createLogger('Scope')` from `electron-log`. No raw `console.*`.

## Tests

- Test files are typechecked by `tsconfig.test.node.json` / `tsconfig.test.web.json`. Both carry an `exclude` backlog of 309 test files that already failed to compile when the gate landed. That list only ever shrinks: never add a file to it. A new or newly-touched test file must compile.
- If you create or modify a test, run it and iterate until it passes.

## Agent Chat

- Start from `docs/superpowers/specs/2026-05-10-agent-chat-design.md` before changing Agent Chat architecture.
- Direction is MCP-first: one localhost Vault MCP server in the main process, reused by Claude CLI, Codex CLI, and local/OpenAI-compatible backends.
- External MCP clients are read-only by default. Writes require an active Memry Agent conversation and approval UI.
- Codex is a first-class backend. Do not detour to the OpenAI API unless asked.
- Provider/model/reasoning changes persist as conversation settings, not one-shot composer state.

## Gotchas

- `better-sqlite3` ERR_DLOPEN_FAILED in tests = NODE_MODULE_VERSION mismatch -> `rebuild:node`.
- Drizzle nullable JSON columns need `null`, not `undefined`, in `.values()`.
- Submit buttons that disable themselves mid-click lose the click. Fire submit from `onPointerDown`, keep `onClick` as keyboard fallback. See `calendar-quick-create-dialog.tsx`.
- `.env.staging` is gitignored and does not travel with a worktree. Without it `resolveSyncServerUrl()` falls back to `http://localhost:8787`. Run `pnpm env:link`.
