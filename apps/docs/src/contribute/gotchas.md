# Common Gotchas

Issues you'll hit while working on memrynote, and the canonical fixes.

## better-sqlite3 NODE_MODULE_VERSION Mismatch

Symptom: `ERR_DLOPEN_FAILED`, `NODE_MODULE_VERSION X but expecting Y`.

Two fix paths depending on the target:

| Target                 | Fix                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------ |
| **Node tests**         | `pnpm rebuild better-sqlite3` (or `bash apps/desktop/scripts/ensure-native.sh node`) |
| **Electron app / E2E** | `bash apps/desktop/scripts/ensure-native.sh electron` (or `pnpm rebuild:electron`)   |

> Using the Node fix for Electron leaves `autoOpenLastVault` silently failing with `ERR_DLOPEN_FAILED`. The app falls through to the "Welcome to memrynote" screen and every E2E test times out on `.bn-container` not visible.

## Zod v4

`z.record(z.unknown())` throws in `safeParse` under Zod v4. Use:

```ts
z.record(z.string(), z.unknown())
```

This caught Phase 3 sync schemas — a few places still use the old form on legacy branches.

## Drizzle Nullable JSON Columns

Drizzle's `.values()` insert distinguishes `null` from `undefined`. For nullable JSON columns, pass `null` explicitly:

```ts
db.insert(tasks).values({
  id,
  fieldClocks: null,    // ← required for nullable JSON
  ...
})
```

Passing `undefined` produces an `INSERT` that omits the column, then SQLite errors on `NOT NULL` columns or returns wrong rows.

## Migrations Are Hand-Written Since 0020

`pnpm db:generate` proposes unrelated renames because Drizzle's meta snapshots stop at `0020`. **Hand-write the SQL and journal entry** instead of running the generator.

Workflow:

1. Update the schema in `packages/db-schema`.
2. Add a new migration file (`migrations/00xx_description.sql`).
3. Append a journal entry in `migrations/meta/_journal.json`.
4. Run `pnpm db:push` to apply.

## Submit Buttons That Disable Mid-Click

If `onClick` calls a handler that synchronously sets state which adds `disabled={isSubmitting}` to the button, the browser **suppresses the click** between `pointerdown` and `click`. The user thinks they clicked but nothing happens.

Fix: fire submit from `onPointerDown`. Keep `onClick` as a keyboard-activation fallback:

```tsx
<button
  onPointerDown={() => void submit()}
  onClick={() => void submit()} // keyboard / accessibility fallback
  disabled={isSubmitting}
>
  Save
</button>
```

See `calendar-quick-create-dialog.tsx` for the canonical version.

## Lazy URL Resolution in http-client

The HTTP client resolves URLs **per-call**, not at module-import time. This avoids tests crashing on import when env vars are absent. If you add a new client, follow the same pattern: read env inside the function, not in module scope.

## Pre-Existing Type Errors

These files have known type errors unrelated to runtime behavior. Ignore them when running `pnpm typecheck`:

- `apps/desktop/src/main/sync/websocket.test.ts`
- `apps/desktop/src/main/folders/folders.test.ts`
- `apps/desktop/src/main/sync/sync-telemetry.ts`

For non-contract changes, use `pnpm typecheck:node && pnpm typecheck:web` to skip the flaky `ipc:check` pre-hook and the pre-existing `sync-telemetry.ts` error.

## Virtualized UI Tests

`@tanstack/react-virtual` + jsdom = zero items rendered (because jsdom doesn't compute scroll heights). Cover virtualized calendar, week-view, and long-list UIs at the **Playwright E2E layer only**.

## CRDT Sign-Out / Sign-In Ordering

When working in `apps/desktop/src/main/sync/runtime.ts`:

```
engine.start()                      # pull from server FIRST
  └─ seedExistingCrdtDocs()         # fire-and-forget, only fills orphans
```

Reversing the order causes split brain. See [CRDT & Notes Sync](/architecture/crdt) for full reasoning.

## Logging

Always use `createLogger('Scope')` from electron-log — never `console.*`. A pre-commit hook flags raw `console.*` calls.

## DevTools Startup

The desktop app does not open DevTools automatically in development or production. Open them manually from the View menu or with the Electron DevTools shortcut when debugging startup.

## User-Facing Errors

Always strip Electron IPC noise from error messages before display:

```ts
import { extractErrorMessage } from '@/lib/ipc-error'

toast.error(extractErrorMessage(err, 'Could not save note'))
```

## RTL-Safe Tailwind

New code must use logical properties (`ms-*`, `pe-*`, `start-*`, `text-start`, `border-s`, `rounded-s-*`) instead of physical ones (`ml-*`, `pr-*`, `left-*`, `text-left`, `border-l`, `rounded-l-*`). The lint config allows physical classes only in pre-existing files.

The staged renderer guard scans whole staged renderer files, not just new hunks. If you touch a file that still has physical direction classes, convert those nearby classes to logical equivalents before committing.

## Security Scan Patterns

GitHub code scanning and the local staged-secret hook are intentionally conservative. When fixing or adding security-sensitive code:

- Compare URL hosts through `new URL(...).hostname` or a DOM anchor fallback, not `string.includes()`.
- Write generated files and vault payloads through exclusive temporary files plus `rename`, not predictable temp paths.
- Use `mkdtemp` for tests that need temporary directories.
- Keep log output sanitized. Do not print signing paths, API responses with headers, or raw error objects that may include request data.
- Invoke package-manager CLIs through a resolved Node/Corepack entry point instead of relying on `PATH`.
- For generated TypeScript, prefer data tables plus runtime assembly over interpolating dynamic keys into code snippets.
- In fixtures, avoid object fields named `token`, `secret`, or `apiKey` when the value is runtime data. Use a neutral field name and keep the real header name only at the request boundary.

## Pre-Production Database

memrynote is pre-production and the DB schema is **resettable**. There are no backward-compat constraints on schema changes within the desktop app. If a migration is messy, deleting the local vault is a valid recovery.
