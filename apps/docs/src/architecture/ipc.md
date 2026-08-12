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

### Agent Chat streaming deltas

`agent:event` is one channel carrying two very different traffic shapes. Turn-lifecycle events (`message_upserted`, `conversation_updated`, `tool_call_*`, `turn_completed`, `turn_error`) are per turn and still fan out to every window through `broadcastToAllWindows`. `assistant_text_delta` is emitted once per token, and a window that does not display that conversation would run the whole agent reducer for text it never renders, so `broadcastAgentEvent` in `src/main/agent/runtime/event-bus.ts` addresses those to the windows that do.

Each window reports what it shows over `agent:setStreamTarget` (`{ conversationId: string | null }`, `null` meaning Agent Chat is open with nothing selected). `AgentProvider` sends it whenever its active conversation changes; main keys the report by `BrowserWindow.id` — the same id the renderer already sends as `sourceWindowId`.

Three properties keep the narrowing safe:

- A window that has never reported is _unknown_, not uninterested. While no live window has reported at all — bootstrap race, agent runtime still lazy-starting — deltas broadcast exactly as before, so a failed registration degrades to the old fan-out rather than to a transcript that never fills in. `agent:setStreamTarget` is answered by the lazy and unavailable handler sets too, so a window that mounts Agent Chat before the runtime exists still becomes known.
- Targeting is per conversation, not per turn, so two windows showing the same conversation both stream. A window skipped mid-stream is never stranded either: the terminal `message_upserted` carries the full text and still goes to everyone.
- Sends are guarded per window like the fan-out helper, and window ids that are no longer live are pruned on each delta, so a window destroyed mid-turn neither throws into the turn loop nor leaves an entry behind.

### Subscribing to a broadcast from the renderer

A high-frequency broadcast must not be subscribed to per component. `useAppUpdater` originally kept `useState` per instance, so its five mounted consumers each ran `updater.getState()` on mount, each registered `onUpdaterStateChanged`, and each re-rendered on every `download-progress` tick — including the one at the App root, which re-rendered the whole tree several times per second during a download.

The pattern to follow is in `src/renderer/src/hooks/use-app-updater.ts`:

- One module-level snapshot behind `useSyncExternalStore`. The first consumer opens the single subscription and does the single `getState()` round-trip; later consumers reuse both.
- Drop the snapshot when the last consumer unsubscribes, so a remount re-reads from main instead of rendering an arbitrarily stale value. Never cache a "nothing to report" result past that.
- Export a selector hook (`useAppUpdaterSelector`) for consumers that need one field. Selectors must return a primitive or an already-stable reference — `useSyncExternalStore` compares with `Object.is`, so returning a fresh object each call loops.

### The `settings:changed` echo

`settings:changed` is broadcast to **every** window, including the one whose write produced it, and the echo must stay that way. A single window holds many independent instances of the same settings hook — `useGeneralSettings` alone has 28 consumer files, each with its own `useState` and no shared context — and only the instance that called `updateSettings` applies the change optimistically. Excluding `event.sender` from the fan-out, or having the renderer drop the event by a `sourceWindowId`, would leave every sibling instance in the writer's own window stale until reload. That is the opposite of the `crdt-provider` case, where the source window genuinely must be skipped.

The redundant work is therefore removed at the value, not at the sender. Subscribers merge the payload through `mergeSettingsPatch(prev, patch)` in `src/renderer/src/lib/settings-patch.ts`, which returns `prev` **by identity** when every patched key already matches. React then bails out of the state update without re-rendering children or firing effects, so an echo that carries nothing new is free. The tabs `UPDATE_SETTINGS` reducer does the same and returns the existing state object unchanged.

This matters most on the sync path: `sync/item-handlers/settings-handler.ts` re-broadcasts the whole merged `general` / `editor` / `inbox` group on every applied settings item, not only the fields that differ, so without the identity check each apply re-rendered every settings consumer in every window. React cannot use its eager-state shortcut on the first dispatch after a real state change, so that one still renders the hook's own component once before bailing out; every subsequent no-op echo costs zero renders.

Write the merge as `setSettings((prev) => mergeSettingsPatch(prev, value))`, never `setSettings((prev) => ({ ...prev, ...value }))` — the spread mints a new object every time and defeats the bail-out. The comparison is shallow, matching the merge it guards; groups whose values are nested objects (keyboard bindings arrive as fresh references over IPC) simply never hit the bail-out, which is correct rather than a missed update.
