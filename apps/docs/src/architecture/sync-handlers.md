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

## Adding a New Sync Type

1. Define a Zod schema in `packages/contracts/<domain>-api.ts`.
2. Add tables / columns in `packages/db-schema` and write a hand-written migration.
3. Implement a handler in `apps/desktop/src/main/sync/item-handlers/<domain>-handler.ts`.
4. Register it in `index.ts`.
5. Add a server-side validator in `apps/sync-server` if the new type has unusual constraints.
6. Add tests under the handler file (every existing handler has one).

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
