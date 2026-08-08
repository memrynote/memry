# IPC Boundary

Renderer ↔ main process communication is type-checked end-to-end by shared contracts.

## Shape

```
┌──────────────┐         ┌─────────────┐         ┌──────────────┐
│   renderer   │ ──IPC── │   preload   │ ──IPC── │     main     │
│  (window.api)│         │ (typed surf)│         │  (handlers)  │
└──────────────┘         └─────────────┘         └──────────────┘
        │                                                │
        └─────── packages/contracts (Zod) ───────────────┘
```

- **Contracts** live in `packages/contracts` and are Zod-typed.
- **Preload** exposes a typed `window.api` surface (no Node access in renderer).
- **Main** registers handlers against the same contract types.

## Files Worth Knowing

```
packages/contracts/
├─ ipc-channels.ts         # channel name constants
├─ <domain>-api.ts         # request/response Zod schemas
└─ telemetry-api.ts        # telemetry surfaces

apps/desktop/src/preload/
└─ index.ts                # window.api surface

apps/desktop/src/main/ipc/
└─ <domain>-handlers.ts    # one file per domain
```

## Invoke Map

`pnpm ipc:generate` regenerates the typed invoke map from contract types. `pnpm ipc:check` runs the typecheck that validates renderer↔main alignment.

When to run:

- After adding or renaming a channel
- After changing a request / response Zod schema
- Before opening any PR that touches the boundary

## Adding a New Channel

1. Add a channel constant to `packages/contracts/ipc-channels.ts`.
2. Define request and response Zod schemas in `packages/contracts/<domain>-api.ts`.
3. Add a handler in `apps/desktop/src/main/ipc/<domain>-handlers.ts`.
4. Expose the call on `window.api` via the preload script.
5. Run `pnpm ipc:generate && pnpm ipc:check`.
6. Use it from the renderer.

## Error Propagation

Renderer-side IPC errors carry Electron noise (stack frames, channel names). Always strip with:

```ts
import { extractErrorMessage } from '@/lib/ipc-error'

try {
  await window.api.notes.create(...)
} catch (err) {
  toast.error(extractErrorMessage(err, 'Could not create note'))
}
```

## Logging

Both sides use `createLogger(scope)` from electron-log. Never `console.*`.

```ts
import { createLogger } from '@/lib/logger'
const log = createLogger('NoteService')
log.info('created note', { id })
```

## Ownership Rules

- The main process owns SQLite, Yjs `Y.Doc`s, and the file system.
- The renderer owns UI state, tabs, and the BlockNote editor.
- CRDT updates flow renderer → main via the Yjs IPC provider; updates are tagged with `sourceWindowId` and Y.Doc origin parameters to prevent loops.

## Main → Renderer Broadcasts

Main-process code that fans an event out to every open window — sync status, task and calendar change events, inbox capture/filing/snooze/transcription events, search and embedding progress, updater state, reminders, agent events, and FTS rebuild progress — goes through `broadcastToAllWindows(channel, data)` in `src/main/lib/window-broadcast.ts`. The helper skips destroyed windows: short-lived windows (splash, quick capture, print/export) can still appear in `BrowserWindow.getAllWindows()` after destruction, and an unguarded `webContents.send()` throws — inside a sync item handler that throw escapes `ctx.emit` within the item's DB transaction and rolls it back. Use the helper instead of hand-rolling a `getAllWindows()` loop.

### Subscribing to a broadcast from the renderer

A high-frequency broadcast must not be subscribed to per component. `useAppUpdater` originally kept `useState` per instance, so its five mounted consumers each ran `updater.getState()` on mount, each registered `onUpdaterStateChanged`, and each re-rendered on every `download-progress` tick — including the one at the App root, which re-rendered the whole tree several times per second during a download.

The pattern to follow is in `src/renderer/src/hooks/use-app-updater.ts`:

- One module-level snapshot behind `useSyncExternalStore`. The first consumer opens the single subscription and does the single `getState()` round-trip; later consumers reuse both.
- Drop the snapshot when the last consumer unsubscribes, so a remount re-reads from main instead of rendering an arbitrarily stale value. Never cache a "nothing to report" result past that.
- Export a selector hook (`useAppUpdaterSelector`) for consumers that need one field. Selectors must return a primitive or an already-stable reference — `useSyncExternalStore` compares with `Object.is`, so returning a fresh object each call loops.
