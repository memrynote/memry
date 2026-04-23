# Folder Icon Sync Design

**Date**: 2026-04-11
**Status**: Draft
**Scope**: Sync folder icons/emojis between devices

## Problem

Folder icons set on deviceA don't appear on deviceB. DeviceB always shows the default folder icon. Root cause: folders are not a sync item type — no handler, no sync payload, no enqueue on write. Folder config lives in `.folder.md` files (YAML frontmatter), identified by path only, with no DB table.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Sync scope | Icon only | Solves reported bug. Other fields (template, views, etc.) added incrementally later. |
| Storage | New `folder_configs` DB table | Sync handler pattern requires DB for clock tracking. Lightweight table bridges file-based storage to sync system. |
| Identity | Path as itemId | Pre-production app, no backward-compat needed. Rename = delete old + create new. |
| Conflict resolution | Doc-level vector clock (LWW) | Single field (icon) doesn't need field-level clocks. Can upgrade later. |

## Architecture

### Data Flow

```
User sets icon on deviceA:
  UI → SET_FOLDER_CONFIG IPC
    → writeFolderConfig() [.folder.md]
    → upsert folder_configs [DB + clock increment]
    → queue.enqueue('folder_config', path, 'update')
    → sync engine pushes to server

Server notifies deviceB:
  → sync engine pulls
  → folder-config-handler.applyUpsert()
    → resolveClockConflict()
    → upsert folder_configs [DB]
    → writeFolderConfig() [.folder.md]
    → emit FOLDER_CONFIG_UPDATED
    → renderer invalidates folders query → UI updates
```

### New DB Table: `folder_configs`

Location: `packages/db-schema/src/schema/folder-configs.ts`

| Column | Type | Constraint | Notes |
|--------|------|------------|-------|
| `path` | `text` | PRIMARY KEY | Relative folder path from notes root (e.g., `"projects/active"`) |
| `icon` | `text` | nullable | Raw emoji (`"🎉"`) or prefixed icon (`"icon:StarIcon"`) |
| `clock` | `text` | nullable | JSON-serialized `VectorClock` |
| `createdAt` | `text` | NOT NULL | UTC ISO timestamp |
| `modifiedAt` | `text` | NOT NULL | UTC ISO timestamp |

Migration: new file in Drizzle migrations.

### Sync Contracts

**1. Sync item type** — `packages/contracts/src/sync-api.ts`

Add `'folder_config'` to `SYNC_ITEM_TYPES` array.

**2. Sync payload schema** — `packages/contracts/src/sync-payloads.ts`

```typescript
export const FolderConfigSyncPayloadSchema = z.object({
  icon: z.string().nullable(),
  clock: VectorClockSchema.optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional()
})

export type FolderConfigSyncPayload = z.infer<typeof FolderConfigSyncPayloadSchema>
```

**3. IPC event** — `packages/contracts/src/ipc-channels.ts`

Add to `NotesChannels.events`:

```typescript
FOLDER_CONFIG_UPDATED: 'notes:folder-config-updated'
```

### Sync Handler

Location: `apps/desktop/src/main/sync/item-handlers/folder-config-handler.ts`

Follows tag-definition handler pattern (simplest — single field, doc-level clock).

**Required methods:**

| Method | Behavior |
|--------|----------|
| `applyUpsert` | Transaction: fetch by path → `resolveClockConflict()` → insert or update DB → `writeFolderConfig()` to keep `.folder.md` in sync → emit `FOLDER_CONFIG_UPDATED` |
| `applyDelete` | Fetch by path → clock check → delete DB row → remove icon from `.folder.md` (delete file if empty config) → emit event |
| `fetchLocal` | Query `folder_configs` by path |
| `buildPushPayload` | Read DB row → serialize `{ icon, clock, createdAt, modifiedAt }` |
| `seedUnclocked` | Called by `engine.seedAllUnclocked()` on first sync enable. Scans all `.folder.md` files for icons → insert into `folder_configs` with initial clock → enqueue for push |

**Handler registration:**

Add to `handlers` Map in `apps/desktop/src/main/sync/item-handlers/index.ts`:

```typescript
['folder_config', folderConfigHandler]
```

### Local Write Path Changes

Location: `apps/desktop/src/main/ipc/notes-handlers.ts` — `SET_FOLDER_CONFIG` handler

Current flow:
1. `writeFolderConfig(folderPath, config)` — writes `.folder.md`

New flow:
1. `writeFolderConfig(folderPath, config)` — writes `.folder.md` (unchanged)
2. Upsert `folder_configs` table — increment clock for device
3. `queue.enqueue({ type: 'folder_config', itemId: folderPath, operation: 'update', payload })` — queue for sync

### Folder Rename Handling

Location: `apps/desktop/src/main/ipc/notes-handlers.ts` — `RENAME_FOLDER` handler

After renaming the filesystem folder:
1. Read old `folder_configs` row
2. Delete old row → enqueue delete for old path
3. Insert new row (same icon, new clock) → enqueue create for new path

### Folder Delete Handling

Location: `apps/desktop/src/main/ipc/notes-handlers.ts` — `DELETE_FOLDER` handler

After deleting the filesystem folder:
1. Delete `folder_configs` row → enqueue delete

### Renderer Integration

Location: `apps/desktop/src/renderer/src/hooks/use-notes-query.ts`

Add event listener for `FOLDER_CONFIG_UPDATED`:
- On event → invalidate `useNoteFoldersQuery`
- No other renderer changes — `FolderIconButton` already reads `icon` from `getFolders()`

### `getFolders()` Update

Location: `apps/desktop/src/main/vault/notes.ts`

Current: reads `.folder.md` files from filesystem.
Enhancement: also check `folder_configs` DB table as fallback/authority for icon field. This ensures icons are correct even if `.folder.md` writeback is delayed.

Priority: DB icon > `.folder.md` icon (DB is source of truth for synced field).

## Testing Strategy (TDD)

### Unit Tests: `folder-config-handler.test.ts`

1. `applyUpsert` — insert new folder config from remote
2. `applyUpsert` — update existing (remote clock newer → applied)
3. `applyUpsert` — skip (local clock newer)
4. `applyUpsert` — conflict (concurrent clocks → merge, LWW)
5. `applyDelete` — removes DB row
6. `applyDelete` — skips if local is newer
7. `seedUnclocked` — discovers `.folder.md` icons, creates DB rows + enqueues
8. `buildPushPayload` — serializes correctly
9. `buildPushPayload` — returns null for missing path

### Unit Tests: Local write path

10. Setting icon → upserts DB + enqueues sync item
11. Setting icon to null → upserts DB + enqueues sync item
12. Rename folder → deletes old + creates new with preserved icon

### Integration Tests

13. Full round-trip: set icon → enqueue → buildPushPayload → applyUpsert on "other device" → verify `.folder.md` written
14. Conflict scenario: two devices set different icons concurrently → verify merge produces one winner

## Out of Scope

- Syncing other FolderConfig fields (template, inherit, views, formulas, properties, summaries)
- Field-level clocks (unnecessary for single-field sync)
- File watcher for `.folder.md` changes (no external edit detection today)
- Folder ordering/position sync

## Future Extensions

When adding more syncable folder fields:
1. Add fields to `FolderConfigSyncPayloadSchema`
2. Define `FOLDER_CONFIG_SYNCABLE_FIELDS` in `field-merge.ts`
3. Add `fieldClocks` column to `folder_configs` table
4. Upgrade handler to use `mergeFields()` instead of doc-level LWW
