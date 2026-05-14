# Testing

Vitest for unit and integration tests, Playwright for E2E (Electron). Tests run via Turborepo so you can scope by package.

## Quick Reference

```bash
pnpm test                              # all packages
pnpm --filter @memry/desktop test      # desktop only
pnpm --filter @memry/sync-server test  # sync server only
pnpm --filter @memry/desktop test:coverage
pnpm --filter @memry/sync-server exec vitest run --coverage --coverage.reporter=json-summary --coverage.reporter=text-summary
pnpm i18n:check                        # hardcoded text + locale resource coverage
pnpm test:i18n-tools                   # i18n scanner/check tool tests
pnpm test:e2e                          # Playwright
node apps/desktop/scripts/build-packaged-app.js --dir
node apps/desktop/scripts/check-packaged-runtime-deps.js
```

## Unit + Integration (Vitest)

Run from the repo root or scope with `--filter`:

```bash
pnpm --filter @memry/desktop test
pnpm --filter @memry/desktop test path/to/file.test.ts
pnpm --filter @memry/desktop test -- --watch
```

Test files live next to the code they cover (`foo.ts` + `foo.test.ts`).

### Key Rules

- Real SQLite (not mocked) for database tests — uses an in-memory DB per test.
- Real crypto (libsodium) — fast enough that mocking isn't worth the divergence risk.
- IPC handlers are tested by importing them directly; no Electron runtime needed.

## E2E (Playwright)

```bash
pnpm test:e2e
pnpm test:e2e --headed                  # see the window
pnpm test:e2e --ui                      # interactive runner
pnpm test:e2e -- tests/notes.spec.ts    # one file
```

> E2E runs against the **built bundle** (`out/main/index.js`), not source. After editing source, rebuild:
>
> ```bash
> npx electron-vite build
> pnpm test:e2e
> ```
>
> Skipping the rebuild is the #1 source of "passes locally, fails in CI" surprises.

### E2E Test Hooks

Desktop E2E helpers live behind `globalThis.__memryTestHooks` and only register when
`NODE_ENV=test`. Keep hooks deterministic and limited to test control surfaces such as seeded
sync data, secondary windows, or Quick Capture shortcut probes. If a flow can be tested through
normal user-visible UI, prefer that path before adding a hook.

Sync E2E bootstrap opens local vault state before attaching shared sync credentials. Keep
`bootstrapSyncDevice` responsible for rebinding the test vault key and starting the sync runtime
before sync assertions run; otherwise queued records can fail before they reach the test backend.
Account-sync E2E should wait until both bootstrapped devices see the complete device list before
revoking a remote device. Removing another device must not emit the current-device revoked event
back into the renderer that initiated the removal.
Split-view E2E locators depend on the pane root exposing `data-testid="tab-pane"`, so keep that
test id stable when changing pane/drop-zone markup.

Agent Chat approval cards render inline in the chat stream, not as modal dialogs. Scope approval
selectors to the Agent chat region, and scope post-approval assertions to the destination surface
instead of broad text that can still appear in the chat transcript or tool arguments.
Vault unit tests import the vault index with narrow Electron mocks. Keep Agent runtime startup behind
vault open/close service functions so note and database tests do not need to load Agent IPC handlers.

### Virtualized UI Tests

`@tanstack/react-virtual` doesn't render any items inside jsdom (heights are zero, virtualization sees no scrollable area). Cover virtualized calendar / week / list UIs at the **Playwright** layer only.

## IPC Contract Check

```bash
pnpm ipc:check       # validate renderer/main contracts typecheck
pnpm ipc:generate    # regenerate the typed invoke map
```

When to run:

- Any time you touch a Zod schema in `packages/contracts`
- Any time you add or rename an IPC channel
- Before opening a PR that touches the boundary

## I18n Checks

```bash
pnpm i18n:check
pnpm test:i18n-tools
```

The i18n check scans desktop source for untranslated UI text, verifies every referenced key exists
in the English bundles, and keeps non-English locale files aligned with English resources. Run the
tool tests when changing `apps/desktop/scripts/i18n/*` so scanner allowlists, JSON output, TODO
limits, and locale-completeness behavior stay covered.

## Focused Typecheck

Skip the flaky pre-hooks and known pre-existing errors:

```bash
pnpm typecheck:node     # main process only
pnpm typecheck:web      # renderer only
```

## Native Module Rebuild

`better-sqlite3` and `keytar` are the most common source of native runtime failures. If you see `ERR_DLOPEN_FAILED`, `NODE_MODULE_VERSION` mismatches, or a Mach-O architecture error:

| Target             | Fix                                                   |
| ------------------ | ----------------------------------------------------- |
| Node tests         | `pnpm rebuild better-sqlite3`                         |
| Electron app / E2E | `bash apps/desktop/scripts/ensure-native.sh electron` |

Using the Node fix for Electron (or vice versa) leaves the app silently broken — see [Common Gotchas](/contribute/gotchas).

## Packaged Runtime Smoke

The packaged smoke check builds the app into `apps/desktop/dist/mac-arm64/Memry.app` from an
isolated dependency tree, then verifies runtime dependencies resolve from the packaged Resources
directory. It also checks native `.node` binaries for the expected macOS architecture so an arm64
release cannot ship with x64 `better-sqlite3` or `keytar` binaries:

```bash
node apps/desktop/scripts/build-packaged-app.js --dir
node apps/desktop/scripts/check-packaged-runtime-deps.js
```

Release builds create one staged dependency tree per macOS architecture. Build x64 on an Intel
runner and arm64 on an Apple Silicon runner; do not build `--x64 --arm64` from the same staged
package, because native modules are rebuilt for one target architecture at a time.

The macOS signing patch in `apps/desktop/scripts/patch-osx-sign-walk.js` walks the packaged app
serially. Keep that traversal bounded; unbounded parallel file reads can exhaust CI file descriptors
while scanning large dependency trees.

Linux release artifacts include the target architecture in both `.deb` and `.AppImage` filenames
so `x64`, `arm64`, and `amd64` builds stay distinguishable in GitHub releases.

## Coverage Targets

Memry is pre-production, but desktop and sync-server coverage are now ratcheted.
Keep new coverage feature-scoped and avoid catch-all test files.

- **Desktop** — configured in `apps/desktop/config/vitest.config.ts`; current floor is
  88% statements, 75% branches, 88% functions, and 90% lines.
- **Sync-server** — configured in `apps/sync-server/vitest.config.ts`; current floor is
  90% for statements, branches, functions, and lines.
- **PRs** — include the relevant coverage command output when raising or defending a
  threshold change.

## Known Test Files With Known Errors

- `websocket.test.ts`
- `folders.test.ts`
- `sync-telemetry.ts`

These have pre-existing TypeScript errors that don't reflect runtime issues. They're tracked and excluded from gating.

## CI Divergence Playbook

When E2E passes locally but fails in CI, walk through in order:

1. **Stale `out/`** — did the CI build succeed before tests?
2. **Error context** — `gh run download` to grab `error-context.md`.
3. **Timezone** — CI runs UTC; date assertions can flake.
4. **Native ABI** — CI rebuilds; check the Electron version is pinned.
5. **xvfb timing** — Electron windows need time to compose; bump waits.
