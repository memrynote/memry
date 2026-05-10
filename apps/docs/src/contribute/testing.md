# Testing

Vitest for unit and integration tests, Playwright for E2E (Electron). Tests run via Turborepo so you can scope by package.

## Quick Reference

```bash
pnpm test                              # all packages
pnpm --filter @memry/desktop test      # desktop only
pnpm --filter @memry/sync-server test  # sync server only
pnpm test:e2e                          # Playwright
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

## Focused Typecheck

Skip the flaky pre-hooks and known pre-existing errors:

```bash
pnpm typecheck:node     # main process only
pnpm typecheck:web      # renderer only
```

## Native Module Rebuild

`better-sqlite3` is the most common source of test failures. If you see `ERR_DLOPEN_FAILED` or `NODE_MODULE_VERSION` mismatches:

| Target             | Fix                                                   |
| ------------------ | ----------------------------------------------------- |
| Node tests         | `pnpm rebuild better-sqlite3`                         |
| Electron app / E2E | `bash apps/desktop/scripts/ensure-native.sh electron` |

Using the Node fix for Electron (or vice versa) leaves the app silently broken — see [Common Gotchas](/contribute/gotchas).

## Coverage Targets

Memry is pre-production, so coverage is pragmatic:

- **Required** — sync, CRDT, and crypto paths
- **Encouraged** — IPC handlers, settings, anything user data-shaped
- **Optional** — pure UI

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
