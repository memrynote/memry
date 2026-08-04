# Sync Item Handlers

Per-type handlers encapsulate how each sync item is encoded, decoded, and merged into the local data DB.

## Pattern

A registry maps each `type` to a handler implementing a shared interface:

```ts
interface SyncItemHandler<T> {
  encode(record: T): Uint8Array
  decode(bytes: Uint8Array): T
  applyUpsert(decoded: T, ctx: SyncContext): void
  applyDelete(id: string, ctx: SyncContext): void
}

const handler = getHandler(item.type)
handler.applyUpsert(decoded, ctx)
```

## Files

```
apps/desktop/src/main/sync/item-handlers/
├─ note-handler.ts
├─ journal-handler.ts
├─ task-handler.ts
├─ project-handler.ts
├─ inbox-handler.ts
├─ template-handler.ts
├─ agent-conversation-handler.ts
├─ agent-message-handler.ts
└─ index.ts              # registry: getHandler(type), getAllHandlers()
```

## Why Strategy Pattern (Phase 3)

Phase 3 replaced a switch-based `ItemApplier` with this registry. The reason: every sync type has subtly different conflict resolution and side effects (e.g. tasks need field-level merge; notes need CRDT integration; inbox items have a triage state machine). Switch statements grew unwieldy.

## Conflict Resolution

Every handler uses the shared `resolveClockConflict()` helper for vector-clock compare and merge.

For tasks, projects, and agent conversations, handlers additionally invoke `mergeFields()` from
`field-merge.ts` to merge field-level vector clocks. See
[Sync Protocol](/architecture/sync-protocol#field-level-merge-tasks-projects).

Agent message sync is append-only. If a message id already exists locally, the handler treats the
remote item as idempotent instead of overwriting a terminal message.

## Atomicity

All `applyUpsert` and `applyDelete` paths run inside `db.transaction()`:

```ts
ctx.db.transaction(() => {
  // upsert into primary table
  // update field_clocks
  // refresh derived index rows
})
```

A partial write is impossible — either every change in a handler invocation applies, or none.

Atomicity stops at the data DB, though. Index rows are derived state, published as projection events
and drained on their own lane, so a handler returns before the index reflects what it just applied.
Anything asking "does this item exist here?" must therefore ask the data DB, or accept that a freshly
applied item can look absent. The debounced CRDT write-back is the case that matters for notes: from
the index alone, a note the handler had already applied looked new, so the write-back re-derived its
title from the Yjs `meta` map — the placeholder a note is created with — and the canonical upsert
overwrote the correct title and path. It now falls back to the canonical row before treating a note
as new.

The Yjs `meta` title is not a source of truth in the other direction either. It is set once at note
creation and updated only while the note's doc is open in memory, so a note renamed from the sidebar
never records the new title there. Read it only when nothing else knows the note.

## Renderer Events From the Sync Path

Handlers notify the renderer through `ctx.emit`, typed `(channel: string, data: unknown)`. That
signature is deliberate — a handler emits on many channels — but it means the renderer-side payload
contract is invisible to `tsc` here, and the write-back path in `crdt-writeback.ts` has the same
hole.

Subscribers do not defend themselves. `useNoteLinks` reads `changes.content` for every note that is
not the open one, so a `notes:updated` emitted without `changes` threw once per note in a pull —
inside the preload listener loop, where each callback is caught individually. Nothing crashed; the
subscriber simply never saw the event, and link caches stopped refreshing after a pull.

Emit through a typed helper rather than `ctx.emit` directly when a channel has a declared payload
type. `note-events.ts` is the pattern:

```ts
export function emitNoteUpdated(
  emit: (channel: string, data: unknown) => void,
  event: NoteUpdatedEvent
): void {
  emit(NotesChannels.events.UPDATED, event)
}
```

Two rules for the `changes` field itself:

- **Only name fields the branch actually wrote.** The handler's markdown-update path rewrites
  frontmatter, title and path but never the note body, so it must leave `content` out. Including it
  would remount an open editor over text that did not change.
- **`content` implies the body moved.** The CRDT write-back is the one emitter that sets it. Because
  `scheduleWriteback` also fires for local typing — a 500ms debounce, ahead of the editor's 1000ms
  save — the note page skips `source: 'sync'` entirely rather than remounting mid-keystroke over
  bytes the IPC CRDT provider has already applied.

The renderer normalizes a missing `changes` to `{}` in `onNoteUpdated`, so a newer renderer stays
tolerant of an older main process. That is a compatibility floor, not a licence to omit the field.

## Adding a New Sync Type

1. Define a Zod schema in `packages/contracts/<domain>-api.ts`.
2. Add tables / columns in `packages/db-schema` and write a hand-written migration.
3. Add the type to every list in `packages/contracts/src/sync-api.ts`: `SYNC_ITEM_TYPES`,
   `RECORD_SYNC_ITEM_TYPES`, `RECORD_CLOCK_REQUIRED_ITEM_TYPES`, and `ENCRYPTABLE_ITEM_TYPES`. Never
   add to `LEGACY_RECORD_SYNC_ITEM_TYPES` — it is frozen at the pre-negotiation client's vocabulary.
4. Implement a handler (the pull side) in
   `apps/desktop/src/main/sync/item-handlers/<domain>-handler.ts`.
5. Register it in `index.ts`.
6. Implement a push service (the local side) in `apps/desktop/src/main/sync/<domain>-sync.ts`, then
   register it in **both** `local-mutations.ts` and the adapter registry in `runtime.ts`.
7. Add a server-side validator in `apps/sync-server` if the new type has unusual constraints.
8. Add tests under the handler file (every existing handler has one).

Steps 5 and 6 are three separate registrations and each fails silently on its own:
`enqueueLocalSync*` typechecks and no-ops when no push service is registered, so the entity never
leaves the device. Cover the seam with a test that runs a local mutation through to a peer's apply,
not just per-side unit tests.

### Initial seeding

Rows written without a vector clock — anything a seed script or an older build inserted — are picked
up by each handler's `seedUnclocked`, driven by `runInitialSeed` on every full sync. That seed reads
the **complete** handler registry (`getAllRemoteSyncAdapters()`), deliberately not the runtime
adapter registry: every other consumer falls back with
`adapters?.getRemote(type) ?? getRemoteSyncAdapter(type)`, but `getAllRemote()` has no fallback, so a
type missing from the runtime list would silently never seed and strand its clock-less rows on that
device forever.

`agent_conversation` and `agent_message` are the intentional exception — their `seedUnclocked`
returns `0` because agent data syncs through the entitlement-gated backfill in `main/agent/sync/`.

Handlers that persist locally encrypted fields must receive the vault key from the sync engine during
pull apply and push payload encoding. Agent conversation and message handlers use that key to decrypt
their SQLite envelopes and re-encode sync payloads without exposing plaintext to the server.

## Field-Level Merge Quick Reference

For tasks and projects:

```ts
const result = mergeFields({
  local: existing,
  remote: incoming,
  fields: TASK_SYNCABLE_FIELDS,
  localFieldClocks: existing.fieldClocks,
  remoteFieldClocks: incoming.fieldClocks
})

// result.merged: T
// result.mergedFieldClocks: FieldClocks
// result.hadConflicts: boolean
// result.conflictedFields: string[]
```

When a record predates Phase 8 and lacks `fieldClocks`, `initAllFieldClocks(docClock, fields)` initializes them on first merge.
