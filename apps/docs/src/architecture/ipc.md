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

The helper also contains a per-window delivery failure: a window that dies between the guard and the send is logged and skipped, so the remaining windows still receive the event and the throw never reaches a caller that is mid-transaction. Payload arity is forwarded as given, so a zero-payload broadcast such as `broadcastToAllWindows('quick-capture:open')` reaches the renderer with no payload argument.

An ESLint `no-restricted-syntax` rule over `apps/desktop/src/main/**` rejects `for...of` and `.forEach` fan-out loops written directly against `BrowserWindow.getAllWindows()`, so the hand-rolled pattern cannot come back. Loops over a deliberate _subset_ of windows are a different thing and stay allowed — for example `crdt-provider` iterates a doc's own `windowIds` and must skip the source window to avoid an IPC echo, which a fan-out would break.

Picking a single window (focusing the app from a notification click, targeting the sender) is also not a fan-out. Those sites take the first _live_ window — `BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())` — rather than `getAllWindows()[0]`, which throws when the window at index 0 has been destroyed.
