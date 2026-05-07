# Common Gotchas

Issues you'll hit, and the canonical fixes.

## better-sqlite3 NODE_MODULE_VERSION mismatch

`ERR_DLOPEN_FAILED` means the native module was built for the wrong runtime.

- **Node tests**: `pnpm rebuild better-sqlite3` (or `bash apps/desktop/scripts/ensure-native.sh node`)
- **Electron app / E2E**: `bash apps/desktop/scripts/ensure-native.sh electron` (or `pnpm rebuild:electron`)

Using the Node fix for Electron leaves `autoOpenLastVault` silently failing; the app falls through to the "Welcome to Memry" screen and E2E tests time out on `.bn-container`.

## Zod v4

`z.record(z.unknown())` throws in `safeParse`. Use `z.record(z.string(), z.unknown())` instead.

## Drizzle nullable JSON columns

Insert `null`, not `undefined`, in `.values()`.

## Migrations Are Hand-Written Since 0020

`pnpm db:generate` proposes unrelated renames because meta snapshots stop at 0020. Hand-write the SQL and journal entry instead.

## Submit-Buttons Disabling Mid-Click

If `onClick` calls a handler that synchronously sets `disabled={isSubmitting}`, the browser suppresses the click between `pointerdown` and `click`. Fire submit from `onPointerDown` and keep `onClick` as a keyboard fallback. See `calendar-quick-create-dialog.tsx`.

## Lazy URL Resolution

http-client resolves URLs per-call (not at import time) to avoid throws in tests.

## Pre-existing Type Errors

`websocket.test.ts`, `folders.test.ts`, and a couple of others have known typecheck errors unrelated to source. Ignore them when running `pnpm typecheck`.

## Virtualized UI Tests

`@tanstack/react-virtual` + jsdom renders zero items. Cover virtualized calendar / week / list UIs at the Playwright E2E layer only.
