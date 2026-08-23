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

Handlers are split across two trees while the `@memry/sync-client` extraction
is in progress. Platform-free handlers — the ones that touch only the data DB
through the driver-agnostic `DrizzleDb` — live in the shared package; handlers
that still reach into desktop-only code (vault files, crypto, converters)
remain in the desktop tree until their seams land:

```
packages/sync-client/src/item-handlers/   # platform-free (shared with mobile)
├─ types.ts              # SyncItemHandler, ApplyContext, resolveClockConflict
├─ base-handler.ts
├─ bookmark-handler.ts
├─ calendar-binding-handler.ts
├─ calendar-external-event-handler.ts
├─ calendar-source-handler.ts
├─ filter-handler.ts
├─ home-page-handler.ts
├─ note-pin-helpers.ts
├─ reminder-handler.ts
├─ tag-category-handler.ts
└─ task-activity-handler.ts

apps/desktop/src/main/sync/item-handlers/ # desktop-bound (for now)
├─ note-handler.ts
├─ journal-handler.ts
├─ task-handler.ts
├─ project-handler.ts
├─ inbox-handler.ts
├─ template-handler.ts
├─ custom-icon-handler.ts
├─ agent-conversation-handler.ts
├─ agent-message-handler.ts
└─ index.ts              # registry: getHandler(type), getAllHandlers()
```

The registry stays in the desktop tree until every handler has moved. The
platform-free record sync services (`bookmark-sync.ts`, `task-sync.ts`, …),
the outbox `queue.ts` and the offline clock helpers moved with the handlers
into `packages/sync-client/src/`.

## Why Strategy Pattern (Phase 3)

Phase 3 replaced a switch-based `ItemApplier` with this registry. The reason: every sync type has subtly different conflict resolution and side effects (e.g. tasks need field-level merge; notes need CRDT integration; inbox items have a triage state machine). Switch statements grew unwieldy.

## Conflict Resolution

Every handler uses the shared `resolveClockConflict()` helper for vector-clock compare and merge.

For tasks, projects, and agent conversations, handlers additionally invoke `mergeFields()` from
`field-merge.ts` to merge field-level vector clocks. See
[Sync Protocol](/architecture/sync-protocol#field-level-merge-tasks-projects).

Agent message sync is append-only. If a message id already exists locally, the handler treats the
remote item as idempotent instead of overwriting a terminal message.

## `buildPushPayload` is optional

`buildPushPayload` rebuilds the outgoing payload from local state at push time, so the newest local
state goes out even when the queued row was frozen earlier. It is optional on the interface, and
`BaseItemHandler` supplies no default. Every handler backed by a sync table implements it; `settings`
does not, because settings live in `config.json` and the preferences cache rather than in a table
there is anything to rebuild from.

A type without it pushes the frozen queue payload verbatim, so queue bookkeeping alone has to be
correct for it — see
[Push acknowledgements and in-flight mutations](/architecture/sync-protocol#push-acknowledgements-and-in-flight-mutations).
When adding a handler, implement it unless the type genuinely has no local row to read back.

## Canvas: the payload comes from a file

`canvas-handler.ts` is the one handler whose content does not live in the data DB. A canvas scene
is a `.excalidraw` file in the vault (see
[Canvas Files](/architecture/local-storage#canvas-files)), so `buildPushPayload` reads the document
off disk and `applyUpsert` writes it there — the row only carries `file_path`, title and clock. A
row whose document is unreadable pushes nothing rather than an empty scene, and the conflict copy
gets its own file next to the winner. None of this touches key material; transport encryption is
unchanged.

## Home boards: the widget layout is an opaque string

`home-page-handler.ts` carries a board's widgets as an **opaque JSON string**, declared
`widgets: z.string().optional()` in `HomePageSyncPayloadSchema` — the same call `canvas.scene` makes,
and for a sharper reason. A typed `z.array(WidgetInstanceSchema)` would zod-strip widget keys written
by a newer build and reject the legacy `{size:'S'|'M'|'L'}` blobs still on disk; `apply-item.ts`
turns a schema failure into `'skipped'`, **not** `'parse_error'`, and `'skipped'` still advances the
cursor and never retries. The push would succeed, `synced_at` would be stamped, and the board would
land on zero peers forever with nothing user-visible to notice.

Shape is therefore validated at the apply site: `applyUpsert` refuses a `widgets` value that is
present but does not `JSON.parse` to an array, and returns `'skipped'` **before** touching the clock
so a later readable version of the same board still wins. An _absent_ `widgets` key is the different
case — the sender predates the field — and keeps the local value.

Two more decisions worth carrying to the next handler like this:

- **Ghost guard.** `pull-coordinator` enqueues `payload: '{}'` on conflict and every payload field is
  optional, so `{}` parses. Without a `if (!data.name) return 'skipped'` guard that materialises a
  permanent ghost row whose empty clock makes every later real version compare as stale. Copied from
  `template-handler.ts`.
- **Hard delete.** Record-sync tombstones live on the server item (`deleted_at`), never in a local
  column. A soft-delete column would also break downgrade inertness: an older build has no
  `deletedAt` in its model and would list tombstoned boards. `applyDelete` refusing a delete when the
  local clock is newer or concurrent — so manifest repair re-pushes the row and clears the server
  tombstone — is the intended "a concurrent local edit beats a remote delete", not the canvas
  resurrection hazard, which is about tombstoned rows in a soft-delete table.

Board _selection_ is deliberately not synced: which board is open stays in
`localStorage['memry-home-active-board']` on each device.

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

## Module-Level Handler State Is Per-Vault

A handler that keeps module-level state — the note handler's guard against re-requesting the same
embedded attachment download is the one that exists — must treat that state as belonging to the open
vault. It is reset from `resetSyncServiceSingletons()`, which runs on sync-runtime stop and therefore
on vault close, vault switch and sign-out, alongside the per-type service singletons. Session-scoped
collections also need a ceiling: the attachment guard is FIFO-capped, because keys are never retired
individually and re-requesting one is cheap (the downloader skips files already on disk).

The same rule holds inside the engine. `CrdtSyncCoordinator` caches an applied-sequence cursor per
note, which after a full sync means the entire vault; `engine.stop()` clears it. Dropping the cursors
is safe because the next pass re-derives `since` from the server snapshot baseline and re-applying a
CRDT update is a no-op.

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

**Every applied write must emit.** A handler that mutates the data DB and returns `applied` without
notifying the renderer leaves an open window showing stale data until the app restarts — the "my
other device changed it but this one still shows the old version" report. `registry.test.ts` walks
`SYNC_ITEM_TYPES`, applies a minimal payload through each registered handler, and fails any type that
returns `applied` without calling `ctx.emit`. The agent conversation and message handlers were
written without one and are the reason the test exists. Only `applied` obligates a broadcast: a
`skipped` or `parse_error` changed nothing locally, so there is nothing to re-read.

Two types are exempt from that probe and say so in the test. `settings` notifies by walking
`BrowserWindow.getAllWindows()` itself rather than going through `ctx.emit`; `note` and `journal`
write the index DB too, so they cannot run against a bare data-db handle and are covered by their own
handler tests instead.

## Nullable Fields: Omitted vs Explicit Null

A nullable column has two distinct remote signals and `??` cannot tell them apart:

- **Key absent** — the sender predates the column. Keep the local value.
- **Key present, value `null`** — an explicit clear. Apply it.

Collapsing them either way loses data. `data.x ?? null` lets an older peer wipe a column it has never
heard of; `data.x ?? existing.x` strands a real clear forever. The inbox handler shipped the first
form for ten columns, so a payload from a build predating any one of them silently nulled the local
value — and an explicit clear is not hypothetical there: `unsnoozeItem`, unarchive and unfile all
push `null` (`main/inbox/snooze.ts`, `main/inbox/crud.ts`). Reading those as "omitted" would leave an
item snoozed on the other device forever.

The house pattern is a local `hasKey` helper over the raw payload:

```ts
const hasKey = (k: string): boolean => Object.prototype.hasOwnProperty.call(data, k)

tx.update(inboxItems).set({
  snoozedUntil: hasKey('snoozedUntil') ? (data.snoozedUntil ?? null) : existing.snoozedUntil
})
```

`calendar-external-event-handler.ts`, `inbox-handler.ts` and `calendar-event-handler.ts` all use it.
Because `buildPushPayload` serializes the whole row, a same-version peer always sends the key — so
`hasKey` is false exactly when the sender is older, which is precisely when the local value must win.

Insert branches need the same audit for a different reason: they simply omitted six inbox columns, so
an item archived on one device arrived un-archived on a device seeing it for the first time. If a
column round-trips through `buildPushPayload`, it has to be written on **both** branches.

## Local-Only Rows Must Not Be Tombstoned

`shouldSkip` on `RecordSyncController` is the "this row never leaves my device" switch, and it has to
hold on delete as well as on create/update. A tombstone carries no body, but the item's id and its
deletion time still get encrypted, uploaded and fanned out to every other device in the vault.

`enqueueDelete` applies it (`packages/sync-core/src/record-sync.ts`), so a service that passes a
`shouldSkip` gets the guard on every path without a second copy inside `buildDeletePayload`.

The guard has one hard limit: it reads the row `load` returns, so it can only fire while that row
still exists.

```ts
const local = this.deps.load(itemId)
if (local !== undefined && this.deps.shouldSkip?.(local)) return
```

When `load` returns `undefined` the row is already gone and its local-only-ness is unknowable, so the
delete is let through deliberately. Refusing there would swallow legitimate tombstones for ordinary
rows — data loss in the opposite direction, and the item would be stranded on every other device.

That splits the record services in two by delete ordering:

- **Enqueue, then delete** — notes and journals. `deleteNoteCommand` (`main/notes/domain.ts`)
  enqueues first precisely so the clock is still readable, so `load` still sees the row and the
  controller guard covers them. Flipping that order would kill the guard silently.
- **Delete, then enqueue** — inbox. `handleDeletePermanent` (`main/inbox/crud.ts`) snapshots the row,
  deletes it, and only then enqueues, so `load` returns `undefined` on that path every time. The
  controller guard can never fire there, so `inbox-sync.ts` guards on the snapshot it is handed —
  the last thing that still knows the flag.

A service in the second shape has to carry its own guard. An unparseable snapshot falls through to
the normal tombstone rather than dropping the delete, so payloads written by older builds keep
working.

## Missing Parents

An FK-bound child whose parent has not arrived yet must throw `MissingSyncParentError` from inside
the transaction, naming the parent type and id:

```ts
if (!parent) throw new MissingSyncParentError('task', taskId, 'project', projectId)
```

`pull-coordinator` routes only that typed error into `orphanedItems`, where `repairOrphans` re-fetches
the parent by id and either replays the child or tombstones it. Let SQLite raise its anonymous
`FOREIGN KEY constraint failed` instead and the coordinator logs "deferred retry failed — item
skipped until next remote update" and drops the item. For an unchanged upstream record — a Google
calendar event nobody has edited — there is no next remote update, so it never appears on that device
at all while the UI keeps reporting the source as connected.

`sortByApplyOrder` ranks parents ahead of children, but only within a page, so cross-page ordering is
unprotected and the guard is what makes it safe. `task-handler.ts`, `calendar-external-event-handler.ts`
and `agent-message-handler.ts` implement it. Never substitute a placeholder id to get past the
constraint: an invented `'unknown-source'` can only ever FK-fail, and it makes the failure
unclassifiable as well as fatal.

## Adding a New Sync Type

1. Define a Zod schema in `packages/contracts/<domain>-api.ts`.
2. Add tables / columns in `packages/db-schema` and write a hand-written migration.
3. Add the type to every list in `packages/contracts/src/sync-api.ts`: `SYNC_ITEM_TYPES`,
   `RECORD_SYNC_ITEM_TYPES`, `RECORD_CLOCK_REQUIRED_ITEM_TYPES`, and `ENCRYPTABLE_ITEM_TYPES`. Never
   add to `LEGACY_RECORD_SYNC_ITEM_TYPES` — it is frozen at the pre-negotiation client's vocabulary.
4. Implement a handler (the pull side) in
   `packages/sync-client/src/item-handlers/<domain>-handler.ts` when it only needs the data DB, or
   `apps/desktop/src/main/sync/item-handlers/<domain>-handler.ts` when it still needs desktop-only
   code.
5. Register it in the desktop registry `index.ts`.
6. Implement a push service (the local side) in `packages/sync-client/src/<domain>-sync.ts`
   (platform-free is the default for record types), then register it in **both**
   `local-mutations.ts` and the adapter registry in `runtime.ts`.
7. Add a server-side validator in `apps/sync-server` if the new type has unusual constraints.
8. Add tests under the handler file (every existing handler has one).
9. Add a minimal payload for the type to `FIXTURE_OVERRIDES` in `item-handlers/registry.test.ts` if
   `{}` does not parse against its schema, and seed any FK parent the fixture needs. The registry
   test fails on an unregistered type and on an applied write that does not emit, so it is the one
   place a half-wired type shows up as a failure rather than as silence.

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

The seed is a safety net, not a licence to write clock-less rows. A type in
`RECORD_CLOCK_REQUIRED_ITEM_TYPES` is rejected by `RecordPushItemSchema` when its push item carries
no clock, and `RecordPushRequestSchema` validates the whole `items` array — so **one** clock-less row
fails the entire batch with a request-level `VALIDATION_ERROR`, not a per-item rejection. Every push
then fails and nothing drains until the row is repaired. Any write path that inserts such a row and
enqueues it must stamp `increment({}, deviceId)` itself; the Google Calendar import
(`calendar/google/sync-service.ts`) does this for events it has never seen before, and
`calendarExternalEventHandler.buildPushPayload` stamps and persists a first clock for rows already
queued by older builds, so a stuck queue drains on the next push instead of waiting for the next full
sync. Stamping without persisting is not enough: the next local edit would tick from `{}` to the same
clock the server already acked, and the update would be dropped as a replay.

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
