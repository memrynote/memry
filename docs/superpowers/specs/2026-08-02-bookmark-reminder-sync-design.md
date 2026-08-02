# Bookmark & Reminder Sync

**Date:** 2026-08-02
**Branch:** `bookmark-reminder-sync`
**Status:** Implemented (PR #914)

## Problem

`bookmarks` and `reminders` are device-local tables in the data DB. Neither appears in
`SYNC_ITEM_TYPES`, neither has a handler under `src/main/sync/item-handlers/`, and no
mutation path enqueues them. A bookmark made on device A never reaches device B; a
reminder set on A never fires on B.

One partial exception exists today: `note_date` reminders are derived from date-pill
tokens in note markdown by `syncNoteDateReminders` (`src/main/notes/note-date-reminders.ts`).
Note content syncs via CRDT, so device B regenerates an equivalent reminder row locally.
The reminder _fires_ on both devices, but the row is independently created, so
`dismissed` / `snoozed` state does not propagate — dismissing on A still rings on B.

## Goals

Add two record-type sync types, `bookmark` and `reminder`, so both converge across
devices under the existing vector-clock LWW model.

Non-goals: no new UI, no change to how reminders are presented or scheduled, no
repair of highlight-offset drift (see Residual Risks).

## Decisions

| Decision               | Choice                   | Rationale                                                                                                                                                |
| ---------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sync model             | `record`, clock-only LWW | Neither table has independently-editable fields needing per-field merge. `fieldClocks` would be unearned complexity.                                     |
| Bookmark identity      | Deterministic id         | Two devices bookmarking the same item offline produce two nanoids for one logical bookmark, colliding on `uniqueIndex(item_type, item_id)` at pull time. |
| Reminder `status`      | Syncs                    | Dismissing on A should silence B. Matches user expectation.                                                                                              |
| Reminder `triggeredAt` | Local-only               | Each device shows its own OS notification; a synced value would suppress the notification on devices that never displayed it.                            |
| `note_date` reminders  | In scope                 | Explicitly chosen; see Derived-vs-Synced below.                                                                                                          |

## Deterministic IDs

Ids are derived by **concatenation, not hashing**, so the SQL migration and the
TypeScript call sites provably produce identical values with no parity risk:

- bookmark: `'bmk_' || item_type || '_' || item_id`
- `note_date` reminder: `'rem_nd_' || target_id || '_' || anchor_id`

`uniqueIndex('idx_bookmarks_unique_item')` on `(item_type, item_id)` guarantees at most
one bookmark row per pair, so the id rewrite is strictly 1:1 — no dedupe, no row loss.

Reminder target types other than `note_date` keep `rem_<nanoid>`. They are user-created
and never independently derived on two devices, so they cannot collide.

Bookmark ids are safe to rewrite: no foreign key references them, and the only consumer
(`reorderBookmarks`) passes ids taken from a freshly-fetched list within a single call.

## Derived-vs-Synced Convergence (`note_date`)

This is the delicate part. `syncNoteDateReminders` runs on every note write and reconciles
reminder rows against date pills in the markdown. With `note_date` also syncing, two
writers target the same logical row.

The deterministic id resolves it: B's reconciler computes the same
`rem_nd_<noteId>_<anchorId>` as the row arriving from A, so the derived row and the synced
row **are the same row** and merge under LWW rather than duplicating.

Three supporting rules:

1. **Write only on real change.** The reconciler compares before writing (it already does)
   and enqueues only when a field actually changed. Without this, every note write
   re-enqueues and two devices ping-pong indefinitely.
2. **Never reset `status` on re-write.** An existing row keeps its status; only `remindAt`
   updates when the pill's computed time differs. A dismiss survives later note edits.
3. **Deletes converge.** Removing a pill deletes the row and enqueues a sync delete. On B
   the CRDT content change drives its own reconciler to the same delete; `applyDelete`
   returns `'skipped'` when the row is already gone, so the duplicate is harmless.

## Field Split

**Bookmark payload:** `itemType`, `itemId`, `position`, `createdAt`, `clock`.
No `modifiedAt` — the table has no such column, and the payload must match the schema.
`position` merges whole-row LWW; concurrent reorders resolve last-writer-wins.

**Reminder payload:** `targetType`, `targetId`, `remindAt`, `anchorId`, `highlightText`,
`highlightStart`, `highlightEnd`, `title`, `note`, `status`, `dismissedAt`,
`snoozedUntil`, `createdAt`, `modifiedAt`, `clock`.

**Excluded: `triggeredAt`.** The handler preserves the existing local value on every
upsert.

## Enqueue Seam

Two independent write paths reach the `reminders` table. Both must enqueue or sync
silently no-ops — the documented #1 failure mode for this change class.

- `packages/app-core/src/reminders.ts` — `createRemindersService`, used by
  `vault/notes-crud.ts` and `sync/crdt-writeback.ts` (the note_date path).
- `apps/desktop/src/main/lib/reminders.ts` — IPC handlers and the 60s scheduler.

`app-core` cannot import desktop sync code without breaking the architecture boundary,
so `createRemindersService(dataDb, hooks?)` gains an optional `onMutate` callback that
desktop wires to the `local-mutations` enqueue functions.

In the scheduler, marking a reminder `triggered` must **not** enqueue (local-only field);
dismiss and snooze must.

Bookmarks have a single write path (`ipc/bookmarks-handlers.ts` via
`database/queries/bookmarks.ts`); create, delete, and reorder each enqueue. Reorder
enqueues one update per moved row.

## Backward Compatibility

Production users run this on real data; every change must work for existing installs.

- New columns (`clock`, `syncedAt`) are additive and nullable — older builds ignore them.
- `LEGACY_RECORD_SYNC_ITEM_TYPES` stays frozen, so pre-negotiation clients never receive
  the new types and cannot fail a page parse. `syncTypesMiddleware` is already merged and
  serving the legacy list to clients that send no `X-Memry-Sync-Types` header.
- `seedUnclocked` clocks and enqueues pre-existing rows on first run, so existing
  bookmarks and reminders reach other devices instead of staying invisible.
- The data-DB migration is hand-written (Drizzle snapshots are broken past 0021) and
  rewrites bookmark ids in place with `UPDATE`, preserving every row.

## Files

Per the `adding-sync-item-type` checklist, applied twice:

- `packages/contracts/src/sync-api.ts` — both types into `SYNC_ITEM_TYPES`,
  `RECORD_SYNC_ITEM_TYPES`, `RECORD_CLOCK_REQUIRED_ITEM_TYPES`, `ENCRYPTABLE_ITEM_TYPES`
- `packages/contracts/src/sync-payloads.ts` (+ `.test.ts`)
- `packages/contracts/src/ipc-channels.ts` — add `UPDATED: 'bookmarks:updated'` to
  `BookmarksChannels.events`, which currently has only `CREATED` / `DELETED` /
  `REORDERED`; the handler needs it for inbound position merges. `ReminderChannels.events`
  already carries `CREATED` / `UPDATED` / `DELETED` and needs no change.
- `packages/db-schema/src/schema/bookmarks.ts`, `schema/reminders.ts`, `data-schema.ts`
- `apps/desktop/src/main/database/drizzle-data/0040_bookmark_reminder_sync.sql` —
  hand-written migration (0039 is the current head)
- `apps/desktop/src/main/sync/item-handlers/{bookmark,reminder}-handler.ts` (+ tests)
- `apps/desktop/src/main/sync/item-handlers/index.ts`
- `apps/desktop/src/main/sync/{bookmark,reminder}-sync.ts`
- `apps/desktop/src/main/sync/offline-clock.ts`, `local-mutations.ts`, `runtime.ts`,
  `manifest-check.ts`
- `apps/desktop/src/main/ipc/bookmarks-handlers.ts`, `lib/reminders.ts`,
  `notes/note-date-reminders.ts`
- `packages/app-core/src/reminders.ts`
- `apps/sync-server/src/services/sync-telemetry.ts` — `toSyncDomain` cases (exhaustive
  switch; typecheck fails without them)

## Testing

Per handler: insert, newer-clock update, older-clock skip, concurrent edit → `'conflict'`,
delete, delete-skip, `seedUnclocked` enqueues.

Targeted at the risk areas identified above:

- Bookmark id rewrite preserves every row and produces the id the TS call site computes.
- `note_date` reconciler + inbound sync converge to exactly one row, not two.
- A second reconciler run after convergence enqueues nothing (loop guard).
- `triggeredAt` survives an inbound upsert; `status` does not reset on note re-write.

## Verification

```bash
pnpm --filter @memry/desktop db:generate && pnpm --filter @memry/desktop db:push
pnpm ipc:generate && pnpm ipc:check
pnpm check:contracts && pnpm check:architecture
pnpm typecheck
pnpm test:desktop && pnpm test:sync-server
pnpm docs:impact --base origin/main --strict && pnpm docs:build
```

Manual: `dev:a` / `dev:b` two-profile run — bookmark on A appears on B; reminder dismissed
on A does not fire on B; concurrent edits resolve LWW with no sync loop.

## Residual Risks

- **Highlight offsets.** `highlight` reminders store character offsets into CRDT-synced
  note text. Offsets can be stale on another device whose text diverged. Pre-existing
  condition, not worsened here; out of scope.
- **Reorder churn.** A full reorder enqueues one update per moved row. Acceptable for
  realistic bookmark counts; revisit if sidebar lists grow large.
- **`note_date` scope.** Chosen deliberately over excluding it. The convergence rests on
  the deterministic id plus the write-only-on-change guard; both are covered by tests
  because a regression here is a sync loop, not a visible bug.
