# Sync Item Handlers

Per-type handlers encapsulate how each sync item is encoded, decoded, and merged.

## Pattern

A registry maps each `type` (note, journal, task, project, inbox, template, …) to a handler implementing a shared interface.

```ts
const handler = getHandler(item.type)
handler.applyUpsert(...)
handler.applyDelete(...)
```

## Files

Handlers live in `apps/desktop/src/main/sync/item-handlers/`.

## Conflict Resolution

Each handler uses the shared `resolveClockConflict()` helper for vector clock compare and merge.

## Atomicity

All `applyUpsert` paths run inside `db.transaction()` so partial writes can't corrupt the data DB.

## Adding a New Type

1. Define a new handler implementing the interface.
2. Register it in the handler registry.
3. Add migration for any new columns or tables.
4. Update the contract types in `packages/contracts`.
