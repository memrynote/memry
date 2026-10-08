# Desktop guide

This directory owns the Electron app (`@memry/desktop`), the reference implementation the other apps follow. Most shared packages in `packages/` run their tests here too, so read this guide before changing them.

## Ownership

- `src/main` is the main process. It owns the vault files, both SQLite databases, every Y.Doc, sync, the keychain, the [capture server](#capture-server), the [Agent MCP server](#agent-chat), and the bundled `memrynote` CLI (`src/main/cli/headless.ts`, see [apps/cli](../cli/AGENTS.md)).
- `src/preload` is the context bridge and holds no logic.
- `src/renderer/src` is the React UI. It reaches main only through preload APIs typed by `packages/contracts`, and `check:architecture` rejects any import of main code.
- `src/test/helpers` holds shared test helpers. `tests/e2e` holds the Playwright specs.
- `apps/docs/src/architecture/` explains each subsystem, including local storage, IPC, CRDT, sync handlers, cryptography, calendar providers, and vault packs. Read the page for the subsystem you change.

## Notes and the index

- A note's identity is its vault-relative path. Its id and dates live in the data DB's `note_metadata`, keyed by path. Memry writes no managed keys into frontmatter. It reads only `tags` and `aliases`, and treats every other key, legacy `id`, `title`, `created`, and `modified` included, as a user property it never rewrites.
- Write paths persist canonical data (the file and `note_metadata`), then publish a projection event. Projectors build the index DB from those events, each from the event payload, never from another projector's output.
- Index reads are eventually consistent. Code that must read its own write back from the index awaits `flushProjectionEvents()`.
- Main owns every Y.Doc, and the renderer edits through the IPC provider. Tag updates with `sourceWindowId`, or an update echoes back to its own window and loops.
- Renderer and main build their BlockNote schema from `packages/editor-schema`. When only one process can build a node or mark, main's y-prosemirror conversion deletes it from the Y.Doc, and the deletion syncs to every device. Change the schema only in that package, and read its README first.

## Databases

- `data.db` holds durable data that no vault file can rebuild, such as tasks, projects, inbox, settings, calendar, sync state, agent conversations, and note metadata. Its schema is `packages/db-schema/src/data-schema.ts`.
- `index.db` derives from the vault and can be dropped and rebuilt. It holds the note cache, FTS, links, tags, extracted text, and the `vec_notes` embeddings. Its schema is `packages/db-schema/src/index-schema.ts`.
- Write migrations by hand for both. Drizzle's snapshots stop at 0021 for data and 0020 for index, so `db:generate` proposes unrelated renames. Update the schema, add `src/main/database/drizzle-data/NNNN_name.sql` (or the `drizzle-index/` equivalent), and append its entry to that folder's `meta/_journal.json`.
- A new journal entry's `when` must exceed every earlier `when`, or existing installs skip the migration silently. `migrate-journal.test.ts` checks this.
- Data DB migrations only add. They keep existing rows valid, and they never drop, rename, or rewrite a table or column that holds user data.
- Drizzle's `.values()` omits a column whose value is `undefined`. Pass `null` for a nullable JSON column.

## IPC and main-process code

- Define a channel in `packages/contracts` and register its handler with `registerCommand` (`src/main/ipc/lib/register-command.ts`) or `createValidatedHandler` (`src/main/ipc/validate.ts`), so the contract schema validates input. Then run `pnpm ipc:generate` and `pnpm ipc:check`.
- Handlers call feature services. `check:architecture` rejects handler imports of `database/queries`, `sync/`, the projection publisher, and the canonical note write path, and it names the rule a file breaks.
- Sync handlers are per item type in `src/main/sync/item-handlers/`, looked up with `getHandler(type)`. Add a handler instead of branching in the caller.
- Built `out/main/index.js` must not statically import `jsdom`, `ai`, `@ai-sdk/*`, or `@blocknote/*`, because they slow startup. Load them with `await import()`. `pnpm --filter @memry/desktop check:main-startup-set` checks a built `out/main`.
- `src/main/index.ts` loads `.env.<mode>` with dotenv after the other modules import, so read env values at call time. A module-level constant freezes the fallback. `resolveSyncServerUrl()` in `packages/sync-client/src/sync-server-url.ts` is the one policy for the sync server URL.
- Log with `createLogger('Scope')` from `src/main/lib/logger.ts`.

## Renderer and UI

- Read `DESIGN.md` before a UI change. Live token values are in `src/renderer/src/assets/base.css`, and `docs/DESIGN_TOKENS.md` catalogs them.
- Every user-visible string goes through i18n. Add keys to `packages/i18n/src/locales/en/<namespace>.json`, and other locales fall back to English. ESLint rejects literal JSX text, user-facing attribute strings, toast strings, and `extractErrorMessage` fallbacks. `pnpm --filter @memry/desktop i18n:check` must pass.
- Show errors with `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`, using a translated fallback.
- Log with `createLogger('Scope')` from `@/lib/logger`.
- Pre-commit scans each staged renderer file in full and rejects raw `console.*` calls and physical direction classes anywhere in it. Clean up a file you touch in the same commit.
- A submit button that sets its own `disabled` state synchronously in `onClick` loses the click, because the browser suppresses `click` once the button turns disabled after `pointerdown`. Fire submit from `onPointerDown` and keep `onClick` as the keyboard fallback, as `calendar-quick-create-dialog.tsx` does.
- React Doctor comments on PRs without failing them. Run `npx -y react-doctor@latest .` in this directory to reproduce its findings.

## Capture server

`src/main/capture/` serves the browser extension over HTTP on `127.0.0.1`, on the first free port from 7849 to 7856. The extension finds the port with `/ping`, and every other route requires the `X-Memry-Capture: 1` header. It pairs through `/pair/request` and `/pair/claim`, captures through `/capture`, and unpairs through `/pair/revoke`. `ArticleCaptureSchema` in `packages/contracts/src/capture-api.ts` validates the capture body. Extensions and desktop update on separate schedules, so every route and field stays readable by older and newer builds of both. Update [apps/extension](../extension/AGENTS.md) in the same change.

## Agent Chat

- Agent Chat is MCP-first. One localhost Vault MCP server in main (`src/main/agent/mcp/`) serves every backend in `src/main/agent/backends/`: the Claude, Codex, and Antigravity CLIs and local OpenAI-compatible providers.
- External MCP clients get the read tools only. Every vault write needs a turn that Memry runs, which holds a single-use write capability, and passes through the approval UI. `apps/docs/src/user-guide/ai/agent-mcp.md` describes the flow.
- Codex is a first-class backend, used through its CLI. Reach for the OpenAI API only when Kaan asks.
- Provider, model, and reasoning changes persist as conversation settings, not one-shot composer state.

## Tests

- `config/vitest.config.ts` defines five projects. `shared` runs the shared packages' tests, `main` and `preload` run in Node, `renderer` runs in jsdom, and `main-integration` runs `*.integration.test.ts` against the real sync-server Worker in miniflare through `tests/sync-harness`. Run one file with `pnpm --filter @memry/desktop test <path>`, or one project with `test:main`, `test:renderer`, `test:shared`, or `test:main-integration`.
- `typecheck:test` compiles test files through `tsconfig.test.node.json` and `tsconfig.test.web.json`. Their `exclude` lists name 284 test files that failed to compile when the gate landed, and the lists only shrink. A new or touched test file compiles and stays off them.
- `test:e2e` runs Playwright against `out/main/index.js` and does not build it. Run `pnpm --filter @memry/desktop exec electron-vite build` after your last code change, then `pnpm --filter @memry/desktop test:e2e <spec>`, once. A fresh worktree has no `out/` and fails with `Cannot find module .../out/main/index.js`, and an existing `out/` may be stale.
- Run `pnpm test:desktop` before calling a broad change done.
- `apps/docs/src/contribute/testing.md` covers seed vaults, E2E keychain cleanup, test hooks, and CI divergence.

## Live app verification

Verify in the running app when a change affects what the user sees or does, such as UI, an IPC flow, or main-process behavior behind a UI action, and one window can exercise the flow. Skip it for pure refactors, tests, docs, sync-server-only changes, and flows that need two synced devices.

1. Build with `pnpm --filter @memry/desktop exec electron-vite build`. Native modules must be built for Electron, and `agent-app.mjs start` fails fast when they are not.
2. Start with `node apps/desktop/scripts/agent-app.mjs start`. It opens a copy of the E2E test vault with a temp profile and an `e2e-agent-*` keychain device, never real data. One instance runs at a time, on CDP port 9222 and inspector port 9229.
3. Drive the flow with the `playwright-memry` MCP server from `.pi/mcp.json`. Snapshot, click, type, and take screenshots.
4. When the change writes data, check it from main with `node apps/desktop/scripts/agent-app.mjs eval "__memryDebug.query('SELECT ...')"`. That SQL is read-only. Seed through the UI or `__memryTestHooks`.
5. Stop with `node apps/desktop/scripts/agent-app.mjs stop`, which removes the temp directories and keychain items.

Report what you exercised and what you observed.

## Native modules

- When Node tests or scripts fail to load `better-sqlite3`, `classic-level`, or `keytar` with `ERR_DLOPEN_FAILED` or a `NODE_MODULE_VERSION` mismatch, run `pnpm --filter @memry/desktop rebuild:node`.
- When Electron dev, E2E, or a build fails to load a native module, run `pnpm --filter @memry/desktop rebuild:electron`.
- Each rebuild proves only its own runtime. `pretest` and `predev` already run the matching one.
- In a fresh worktree, `pnpm install` starts a detached Electron rebuild (the root `scripts/warm-native.mjs`), and a long quiet period there is not a hang. Watch it with `pnpm warm:log`, or run it in the foreground with `pnpm warm`.
- The macOS calendar bridge in `native/eventkit` is a Swift helper executable, not a Node module, and neither rebuild touches it. `predev` builds it on macOS when it can, and `build:eventkit` builds it on demand. Both need the Xcode command line tools. Without it, This Mac reports unavailable and nothing else changes. Unit tests use a fake helper. See `native/eventkit/README.md`.
- `apps/docs/src/contribute/gotchas.md` lists more native pitfalls, such as `electron-rebuild -o classic-level` doing nothing.

## Environments and commands

- `pnpm dev` from the repo root runs against the local sync server, and `pnpm staging` runs against staging. To test sync between desktops, `pnpm --filter @memry/desktop dev:a` runs a separate device profile, and so do `dev:b`, `dev:c`, and the `:staging` forms such as `dev:a:staging`.
- `.env.staging` is gitignored and does not travel with a worktree. Without it, staging mode quietly talks to `http://localhost:8787`. Run `pnpm env:link`.
- `typecheck:node`, `typecheck:web`, and `typecheck:test` are the fast slices of `typecheck`, which runs `check:contracts`, `check:architecture`, and `ipc:check` first.
- Run `build:release`, `build:mac:signed:local`, or any signing or notarization command only when Kaan asks.
