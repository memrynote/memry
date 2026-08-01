# Bookmark & Reminder Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `bookmarks` and `reminders` data-DB tables sync across devices as two new record-type sync items.

**Architecture:** Both types follow the `filter` template — record sync with whole-row last-write-wins under a vector clock, no `fieldClocks`. Identity is made deterministic by string concatenation so two devices independently producing the same logical row converge onto one id instead of colliding. Reminder `triggeredAt` stays device-local; everything else about a reminder syncs.

**Tech Stack:** TypeScript, Drizzle ORM (better-sqlite3), Zod v4, Vitest, Electron main process, Hono (sync-server).

**Spec:** `docs/superpowers/specs/2026-08-02-bookmark-reminder-sync-design.md`

## Global Constraints

- **Backward compatibility is MANDATORY.** Real users run this on real data. No DB resets. All schema changes additive.
- Data-DB migrations are **hand-written** SQL under `apps/desktop/src/main/database/drizzle-data/`. Drizzle snapshots are broken past 0021. Current head is `0039_attachment_upload_queue.sql`.
- `LEGACY_RECORD_SYNC_ITEM_TYPES` in `packages/contracts/src/sync-api.ts` is **FROZEN**. Never add to it.
- Logging: always `createLogger('Scope')`, never raw `console.*`.
- User-facing errors: always `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`.
- Git commits: do **not** add `Co-Authored-By` trailers.
- Shell commands are wrapped with `rtk` where supported; use plain `pnpm`/`npx`.
- Zod v4: `z.record(z.unknown())` throws in safeParse — always `z.record(z.string(), z.unknown())`.
- Sync payload fields are **all optional** (forward-tolerance): a payload from a newer client must still parse on an older one, degrading to `skip` rather than failing a whole page and advancing the cursor past good data.

---

### Task 1: Contracts — sync types, payloads, channels, telemetry

Adding an item type to `SyncItemType` breaks the exhaustive switch in the sync-server telemetry service, so that fix ships in this same task to keep `pnpm typecheck` green at commit time.

**Files:**

- Modify: `packages/contracts/src/sync-api.ts`
- Modify: `packages/contracts/src/sync-payloads.ts`
- Modify: `packages/contracts/src/ipc-channels.ts:594-601`
- Modify: `packages/contracts/src/bookmark-types.ts`
- Modify: `packages/contracts/src/reminder-types.ts`
- Modify: `apps/sync-server/src/services/sync-telemetry.ts:8-61`
- Test: `packages/contracts/src/sync-payloads.test.ts`

**Interfaces:**

- Produces: `BookmarkSyncPayloadSchema`, `BookmarkSyncPayload`, `ReminderSyncPayloadSchema`, `ReminderSyncPayload` (from `@memry/contracts/sync-payloads`); `bookmarkSyncId(itemType, itemId): string`; `noteDateReminderId(noteId, anchorId): string`.

- [ ] **Step 1: Write the failing payload tests**

Append to `packages/contracts/src/sync-payloads.test.ts`:

```ts
import { BookmarkSyncPayloadSchema, ReminderSyncPayloadSchema } from './sync-payloads'

describe('BookmarkSyncPayloadSchema', () => {
  it('parses a full payload', () => {
    const result = BookmarkSyncPayloadSchema.safeParse({
      itemType: 'note',
      itemId: 'note_1',
      position: 3,
      createdAt: '2026-08-02T00:00:00.000Z',
      clock: { device_a: 2 }
    })
    expect(result.success).toBe(true)
  })

  it('parses an empty payload (forward tolerance)', () => {
    expect(BookmarkSyncPayloadSchema.safeParse({}).success).toBe(true)
  })

  it('ignores unknown fields from a newer client', () => {
    const result = BookmarkSyncPayloadSchema.safeParse({ itemId: 'n1', futureField: 'x' })
    expect(result.success).toBe(true)
  })
})

describe('ReminderSyncPayloadSchema', () => {
  it('parses a full payload', () => {
    const result = ReminderSyncPayloadSchema.safeParse({
      targetType: 'note',
      targetId: 'note_1',
      remindAt: '2026-08-03T09:00:00.000Z',
      anchorId: 'anchor_1',
      highlightText: 'hello',
      highlightStart: 0,
      highlightEnd: 5,
      title: 'Check this',
      note: 'because',
      status: 'pending',
      dismissedAt: null,
      snoozedUntil: null,
      createdAt: '2026-08-02T00:00:00.000Z',
      modifiedAt: '2026-08-02T00:00:00.000Z',
      clock: { device_a: 1 }
    })
    expect(result.success).toBe(true)
  })

  it('parses an empty payload (forward tolerance)', () => {
    expect(ReminderSyncPayloadSchema.safeParse({}).success).toBe(true)
  })

  it('has no triggeredAt field — it is device-local', () => {
    const parsed = ReminderSyncPayloadSchema.parse({ triggeredAt: '2026-08-02T00:00:00.000Z' })
    expect('triggeredAt' in parsed).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @memry/contracts test -- sync-payloads`
Expected: FAIL — `BookmarkSyncPayloadSchema` is not exported.

- [ ] **Step 3: Add the payload schemas**

In `packages/contracts/src/sync-payloads.ts`, after `FilterSyncPayloadSchema` (line 53):

```ts
export const BookmarkSyncPayloadSchema = z.object({
  itemType: z.string().optional(),
  itemId: z.string().optional(),
  position: z.number().optional(),
  clock: VectorClockSchema.optional(),
  createdAt: z.string().optional()
})

/**
 * Reminder sync payload.
 *
 * `triggeredAt` is deliberately ABSENT: each device shows its own OS
 * notification, so a synced value would suppress the notification on a device
 * that never displayed it. Dismiss/snooze state DOES sync, so silencing a
 * reminder on one device silences it everywhere.
 */
export const ReminderSyncPayloadSchema = z.object({
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  remindAt: z.string().optional(),
  anchorId: z.string().nullable().optional(),
  highlightText: z.string().nullable().optional(),
  highlightStart: z.number().nullable().optional(),
  highlightEnd: z.number().nullable().optional(),
  title: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  status: z.string().optional(),
  dismissedAt: z.string().nullable().optional(),
  snoozedUntil: z.string().nullable().optional(),
  clock: VectorClockSchema.optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional()
})
```

Then add the inferred types alongside the other payload type exports:

```ts
export type BookmarkSyncPayload = z.infer<typeof BookmarkSyncPayloadSchema>
export type ReminderSyncPayload = z.infer<typeof ReminderSyncPayloadSchema>
```

- [ ] **Step 4: Add both types to the four sync-api arrays**

In `packages/contracts/src/sync-api.ts`, add `'bookmark'` and `'reminder'` to each of `SYNC_ITEM_TYPES`, `RECORD_SYNC_ITEM_TYPES`, `RECORD_CLOCK_REQUIRED_ITEM_TYPES`, and `ENCRYPTABLE_ITEM_TYPES` (the last ends at line 117).

Do **NOT** touch `LEGACY_RECORD_SYNC_ITEM_TYPES` (lines 78-94) or `CRDT_SYNC_ITEM_TYPES` (line 64).

Missing `ENCRYPTABLE_ITEM_TYPES` is the silent killer: encryption refuses the type and sync drops it with no error.

- [ ] **Step 5: Add the deterministic id helpers**

In `packages/contracts/src/bookmark-types.ts`:

```ts
/**
 * Deterministic bookmark id.
 *
 * Two devices bookmarking the same item offline would otherwise mint two
 * nanoids for one logical bookmark and collide on the
 * `(item_type, item_id)` unique index at pull time. Deriving the id from the
 * same pair makes both devices produce the identical row, so LWW merges it.
 *
 * MUST stay character-identical to the SQL in migration 0040.
 */
export function bookmarkSyncId(itemType: string, itemId: string): string {
  return `bmk_${itemType}_${itemId}`
}
```

In `packages/contracts/src/reminder-types.ts`:

```ts
/**
 * Deterministic id for `note_date` reminders.
 *
 * These rows are derived from date pills in note markdown by
 * `syncNoteDateReminders`, which runs on every note write on EVERY device.
 * Because note content syncs via CRDT, device B derives the same reminder that
 * device A already synced. A random id would produce two rows for one pill;
 * this makes them the same row.
 *
 * MUST stay character-identical to the SQL in migration 0040.
 */
export function noteDateReminderId(noteId: string, anchorId: string): string {
  return `rem_nd_${noteId}_${anchorId}`
}
```

- [ ] **Step 6: Add the bookmarks UPDATED event channel**

In `packages/contracts/src/ipc-channels.ts`, inside `BookmarksChannels.events` (lines 594-601), add between `CREATED` and `DELETED`:

```ts
    /** Bookmark was updated (e.g. position merged from another device) */
    UPDATED: 'bookmarks:updated',
```

`ReminderChannels.events` already has `CREATED` / `UPDATED` / `DELETED` — leave it alone.

- [ ] **Step 7: Extend the sync-server telemetry domain switch**

In `apps/sync-server/src/services/sync-telemetry.ts`, add to the `SyncDomain` union (line 8-20):

```ts
  | 'bookmarks'
  | 'reminders'
```

And to `toSyncDomain`'s switch, after the `case 'canvas':` arm:

```ts
    case 'bookmark':
      return 'bookmarks'
    case 'reminder':
      return 'reminders'
```

The switch has no `default` and is exhaustive over `SyncItemType`; typecheck fails until both arms exist.

- [ ] **Step 8: Run tests and typecheck**

Run: `pnpm --filter @memry/contracts test -- sync-payloads && pnpm typecheck && pnpm check:contracts`
Expected: tests PASS, typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts apps/sync-server/src/services/sync-telemetry.ts
git commit -m "feat(sync): add bookmark and reminder sync contracts"
```

---

### Task 2: Database schema and migration 0040

**Files:**

- Modify: `packages/db-schema/src/schema/bookmarks.ts`
- Modify: `packages/db-schema/src/schema/reminders.ts`
- Create: `apps/desktop/src/main/database/drizzle-data/0040_bookmark_reminder_sync.sql`
- Test: `apps/desktop/src/main/database/migrate.test.ts`

**Interfaces:**

- Consumes: `bookmarkSyncId`, `noteDateReminderId` (Task 1).
- Produces: `bookmarks.clock`, `bookmarks.syncedAt`, `reminders.clock`, `reminders.syncedAt` columns.

- [ ] **Step 1: Write the failing migration test**

Append to `apps/desktop/src/main/database/migrate.test.ts` (follow the existing file's harness for opening a migrated in-memory DB):

```ts
describe('migration 0040 — bookmark/reminder sync columns', () => {
  it('rewrites bookmark ids deterministically and preserves every row', () => {
    const db = openMigratedDbAt('0039')
    db.prepare(
      `INSERT INTO bookmarks (id, item_type, item_id, position, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run('nanoid_legacy_1', 'note', 'note_abc', 0, '2026-01-01T00:00:00.000Z')

    applyMigration(db, '0040')

    const rows = db.prepare('SELECT * FROM bookmarks').all()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('bmk_note_note_abc')
    expect(rows[0].item_id).toBe('note_abc')
    expect(rows[0].position).toBe(0)
  })

  it('collapses duplicate note_date reminders before rewriting ids', () => {
    const db = openMigratedDbAt('0039')
    const insert = db.prepare(
      `INSERT INTO reminders (id, target_type, target_id, remind_at, anchor_id, status, created_at, modified_at)
       VALUES (?, 'note_date', ?, ?, ?, 'pending', ?, ?)`
    )
    insert.run(
      'rem_a',
      'note_1',
      '2026-08-03T09:00:00.000Z',
      'anchor_1',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    )
    insert.run(
      'rem_b',
      'note_1',
      '2026-08-03T09:00:00.000Z',
      'anchor_1',
      '2026-01-02T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z'
    )

    applyMigration(db, '0040')

    const rows = db.prepare("SELECT * FROM reminders WHERE target_type = 'note_date'").all()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('rem_nd_note_1_anchor_1')
  })

  it('leaves non-note_date reminder ids untouched', () => {
    const db = openMigratedDbAt('0039')
    db.prepare(
      `INSERT INTO reminders (id, target_type, target_id, remind_at, status, created_at, modified_at)
       VALUES ('rem_keepme', 'note', 'note_1', '2026-08-03T09:00:00.000Z', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    ).run()

    applyMigration(db, '0040')

    const row = db.prepare("SELECT id FROM reminders WHERE target_type = 'note'").get()
    expect(row.id).toBe('rem_keepme')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- migrate`
Expected: FAIL — migration 0040 does not exist.

- [ ] **Step 3: Write the migration SQL**

Create `apps/desktop/src/main/database/drizzle-data/0040_bookmark_reminder_sync.sql`:

```sql
-- Bookmark & reminder sync.
--
-- Adds vector-clock columns to both tables and rewrites identities that must be
-- deterministic across devices. Additive and row-preserving: no DELETE except
-- the duplicate collapse below, which is required for the PK rewrite to succeed.

ALTER TABLE bookmarks ADD COLUMN clock TEXT;
ALTER TABLE bookmarks ADD COLUMN synced_at TEXT;

ALTER TABLE reminders ADD COLUMN clock TEXT;
ALTER TABLE reminders ADD COLUMN synced_at TEXT;

-- Bookmark ids become 'bmk_' || item_type || '_' || item_id.
--
-- Two-phase via a temp prefix so an incoming deterministic id can never
-- transiently collide with another row's not-yet-rewritten id.
--
-- idx_bookmarks_unique_item on (item_type, item_id) guarantees at most one row
-- per pair, so this mapping is strictly 1:1 — every row survives.
UPDATE bookmarks SET id = 'tmp0040_' || id;
UPDATE bookmarks SET id = 'bmk_' || item_type || '_' || item_id;

-- note_date reminders are derived from date pills and must be identical on
-- every device. Unlike bookmarks there is no unique index, so pre-existing
-- duplicates would collide on the PK rewrite. Collapse them first, keeping the
-- lowest id per (target_id, anchor_id).
DELETE FROM reminders
WHERE target_type = 'note_date'
  AND anchor_id IS NOT NULL
  AND id NOT IN (
    SELECT MIN(id) FROM reminders
    WHERE target_type = 'note_date' AND anchor_id IS NOT NULL
    GROUP BY target_id, anchor_id
  );

UPDATE reminders SET id = 'tmp0040_' || id
WHERE target_type = 'note_date' AND anchor_id IS NOT NULL;

UPDATE reminders SET id = 'rem_nd_' || target_id || '_' || anchor_id
WHERE target_type = 'note_date' AND anchor_id IS NOT NULL;
```

- [ ] **Step 4: Add the Drizzle columns**

In `packages/db-schema/src/schema/bookmarks.ts`, import `VectorClock` and add to the table definition after `createdAt`:

```ts
  clock: text('clock', { mode: 'json' }).$type<VectorClock>(),
  syncedAt: text('synced_at')
```

Add the import at the top:

```ts
import type { VectorClock } from '@memry/contracts/sync-api'
```

Apply the identical two-column addition to `packages/db-schema/src/schema/reminders.ts` after its `modifiedAt` column.

- [ ] **Step 5: Register the migration in the Drizzle journal**

A hand-written migration is invisible to Drizzle's migrator unless it is listed in `apps/desktop/src/main/database/drizzle-data/meta/_journal.json`. Append to the `entries` array, after the existing `idx: 39` entry:

```json
{
  "idx": 40,
  "version": "6",
  "when": 1785628800000,
  "tag": "0040_bookmark_reminder_sync",
  "breakpoints": true
}
```

`when` MUST be strictly greater than 0039's `1784831400000`. A non-increasing timestamp makes the migrator skip the file silently.

- [ ] **Step 6: Run migration and tests**

Do **NOT** run `db:generate` for the data DB — Drizzle snapshots are broken past 0021 and it would emit a bogus migration over the hand-written one.

```bash
pnpm --filter @memry/desktop db:push
pnpm --filter @memry/desktop test:main -- migrate
```

Expected: migration applies, all three tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db-schema apps/desktop/src/main/database
git commit -m "feat(sync): add clock columns and deterministic ids for bookmarks and reminders"
```

---

### Task 3: Bookmark sync handler

**Files:**

- Create: `apps/desktop/src/main/sync/item-handlers/bookmark-handler.ts`
- Test: `apps/desktop/src/main/sync/item-handlers/bookmark-handler.test.ts`
- Modify: `apps/desktop/src/main/sync/item-handlers/index.ts`

**Interfaces:**

- Consumes: `BookmarkSyncPayloadSchema`, `BookmarkSyncPayload` (Task 1); `bookmarks.clock` / `.syncedAt` (Task 2).
- Produces: `bookmarkHandler` — a `BaseItemHandler<BookmarkSyncPayload>` with `type = 'bookmark'`.

- [ ] **Step 1: Write the failing handler test**

Create `apps/desktop/src/main/sync/item-handlers/bookmark-handler.test.ts`, modelled on `task-handler.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { bookmarkHandler } from './bookmark-handler'
import { bookmarks } from '@memry/db-schema/schema/bookmarks'
import { createTestDb } from './__tests__/helpers'

describe('bookmarkHandler', () => {
  let db: ReturnType<typeof createTestDb>
  let emit: ReturnType<typeof vi.fn>
  let ctx: { db: typeof db; emit: typeof emit }

  beforeEach(() => {
    db = createTestDb()
    emit = vi.fn()
    ctx = { db, emit }
  })

  const payload = {
    itemType: 'note',
    itemId: 'note_1',
    position: 0,
    createdAt: '2026-08-02T00:00:00.000Z'
  }

  it('inserts a new bookmark', () => {
    const result = bookmarkHandler.applyUpsert(ctx, 'bmk_note_note_1', payload, { a: 1 })
    expect(result).toBe('applied')
    const row = db.select().from(bookmarks).get()
    expect(row.itemId).toBe('note_1')
    expect(row.clock).toEqual({ a: 1 })
  })

  it('applies a newer-clock update', () => {
    bookmarkHandler.applyUpsert(ctx, 'bmk_note_note_1', payload, { a: 1 })
    const result = bookmarkHandler.applyUpsert(
      ctx,
      'bmk_note_note_1',
      { ...payload, position: 5 },
      { a: 2 }
    )
    expect(result).toBe('applied')
    expect(db.select().from(bookmarks).get().position).toBe(5)
  })

  it('skips an older-clock update', () => {
    bookmarkHandler.applyUpsert(ctx, 'bmk_note_note_1', payload, { a: 2 })
    const result = bookmarkHandler.applyUpsert(
      ctx,
      'bmk_note_note_1',
      { ...payload, position: 9 },
      { a: 1 }
    )
    expect(result).toBe('skipped')
    expect(db.select().from(bookmarks).get().position).toBe(0)
  })

  it('reports concurrent edits as conflict', () => {
    bookmarkHandler.applyUpsert(ctx, 'bmk_note_note_1', payload, { a: 1 })
    const result = bookmarkHandler.applyUpsert(
      ctx,
      'bmk_note_note_1',
      { ...payload, position: 3 },
      { b: 1 }
    )
    expect(result).toBe('conflict')
  })

  it('deletes a bookmark', () => {
    bookmarkHandler.applyUpsert(ctx, 'bmk_note_note_1', payload, { a: 1 })
    expect(bookmarkHandler.applyDelete(ctx, 'bmk_note_note_1', { a: 2 })).toBe('applied')
    expect(db.select().from(bookmarks).all()).toHaveLength(0)
  })

  it('skips deleting an unknown bookmark', () => {
    expect(bookmarkHandler.applyDelete(ctx, 'bmk_note_missing', { a: 1 })).toBe('skipped')
  })

  it('seedUnclocked clocks and enqueues pre-existing rows', () => {
    db.insert(bookmarks)
      .values({ id: 'bmk_note_note_1', itemType: 'note', itemId: 'note_1', position: 0 })
      .run()
    const queue = { enqueue: vi.fn() }
    const count = bookmarkHandler.seedUnclocked(db, 'device_a', queue as never)
    expect(count).toBe(1)
    expect(queue.enqueue).toHaveBeenCalledOnce()
    expect(db.select().from(bookmarks).get().clock).toEqual({ device_a: 1 })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- bookmark-handler`
Expected: FAIL — cannot resolve `./bookmark-handler`.

- [ ] **Step 3: Implement the handler**

Create `apps/desktop/src/main/sync/item-handlers/bookmark-handler.ts`:

```ts
import { eq, isNull } from 'drizzle-orm'
import { bookmarks } from '@memry/db-schema/schema/bookmarks'
import { BookmarkSyncPayloadSchema, type BookmarkSyncPayload } from '@memry/contracts/sync-payloads'
import { BookmarksChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import { utcNow } from '@memry/shared/utc'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('BookmarkHandler')

class BookmarkHandler extends BaseItemHandler<BookmarkSyncPayload> {
  readonly type = 'bookmark' as const
  readonly schema = BookmarkSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: BookmarkSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(bookmarks).where(eq(bookmarks.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveClock(existing.clock, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote bookmark update, local is newer', { itemId })
          return 'skipped'
        }
        if (resolution.action === 'merge') {
          log.warn('Concurrent bookmark edit, using last-write-wins', { itemId })
        }

        tx.update(bookmarks)
          .set({
            itemType: data.itemType ?? existing.itemType,
            itemId: data.itemId ?? existing.itemId,
            position: data.position ?? existing.position,
            clock: resolution.mergedClock,
            syncedAt: now
          })
          .where(eq(bookmarks.id, itemId))
          .run()

        ctx.emit(BookmarksChannels.events.UPDATED, { id: itemId })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      tx.insert(bookmarks)
        .values({
          id: itemId,
          itemType: data.itemType ?? 'note',
          itemId: data.itemId ?? '',
          position: data.position ?? 0,
          clock: remoteClock,
          syncedAt: now,
          createdAt: data.createdAt ?? now
        })
        .run()

      ctx.emit(BookmarksChannels.events.CREATED, { id: itemId })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(bookmarks).where(eq(bookmarks.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote bookmark delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(bookmarks).where(eq(bookmarks.id, itemId)).run()
    ctx.emit(BookmarksChannels.events.DELETED, { id: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(bookmarks).where(eq(bookmarks.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const bookmark = db.select().from(bookmarks).where(eq(bookmarks.id, itemId)).get()
    if (!bookmark) return null
    return JSON.stringify(bookmark)
  }

  markPushSynced(db: DrizzleDb, itemId: string): void {
    db.update(bookmarks).set({ syncedAt: utcNow() }).where(eq(bookmarks.id, itemId)).run()
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(bookmarks).where(isNull(bookmarks.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(bookmarks).set({ clock }).where(eq(bookmarks.id, item.id)).run()
      queue.enqueue({
        type: 'bookmark',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const bookmarkHandler = new BookmarkHandler()
```

- [ ] **Step 4: Register the handler**

In `apps/desktop/src/main/sync/item-handlers/index.ts`, import `bookmarkHandler` and add `['bookmark', bookmarkHandler]` to the handlers Map.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @memry/desktop test:main -- bookmark-handler`
Expected: all 7 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/sync/item-handlers
git commit -m "feat(sync): add bookmark sync handler"
```

---

### Task 4: Reminder sync handler

The one behaviour that differs from every other handler in the repo: `triggeredAt` must survive an inbound upsert untouched.

**Files:**

- Create: `apps/desktop/src/main/sync/item-handlers/reminder-handler.ts`
- Test: `apps/desktop/src/main/sync/item-handlers/reminder-handler.test.ts`
- Modify: `apps/desktop/src/main/sync/item-handlers/index.ts`

**Interfaces:**

- Consumes: `ReminderSyncPayloadSchema`, `ReminderSyncPayload` (Task 1); `reminders.clock` / `.syncedAt` (Task 2).
- Produces: `reminderHandler` — a `BaseItemHandler<ReminderSyncPayload>` with `type = 'reminder'`.

- [ ] **Step 1: Write the failing handler test**

Create `apps/desktop/src/main/sync/item-handlers/reminder-handler.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { reminderHandler } from './reminder-handler'
import { reminders } from '@memry/db-schema/schema/reminders'
import { createTestDb } from './__tests__/helpers'

describe('reminderHandler', () => {
  let db: ReturnType<typeof createTestDb>
  let emit: ReturnType<typeof vi.fn>
  let ctx: { db: typeof db; emit: typeof emit }

  beforeEach(() => {
    db = createTestDb()
    emit = vi.fn()
    ctx = { db, emit }
  })

  const payload = {
    targetType: 'note',
    targetId: 'note_1',
    remindAt: '2026-08-03T09:00:00.000Z',
    status: 'pending',
    createdAt: '2026-08-02T00:00:00.000Z',
    modifiedAt: '2026-08-02T00:00:00.000Z'
  }

  it('inserts a new reminder', () => {
    expect(reminderHandler.applyUpsert(ctx, 'rem_1', payload, { a: 1 })).toBe('applied')
    expect(db.select().from(reminders).get().targetId).toBe('note_1')
  })

  it('propagates a dismiss from another device', () => {
    reminderHandler.applyUpsert(ctx, 'rem_1', payload, { a: 1 })
    reminderHandler.applyUpsert(
      ctx,
      'rem_1',
      { ...payload, status: 'dismissed', dismissedAt: '2026-08-03T10:00:00.000Z' },
      { a: 2 }
    )
    const row = db.select().from(reminders).get()
    expect(row.status).toBe('dismissed')
    expect(row.dismissedAt).toBe('2026-08-03T10:00:00.000Z')
  })

  it('preserves local triggeredAt across an inbound upsert', () => {
    reminderHandler.applyUpsert(ctx, 'rem_1', payload, { a: 1 })
    db.update(reminders).set({ triggeredAt: '2026-08-03T09:00:01.000Z' }).run()

    reminderHandler.applyUpsert(ctx, 'rem_1', { ...payload, title: 'renamed' }, { a: 2 })

    const row = db.select().from(reminders).get()
    expect(row.triggeredAt).toBe('2026-08-03T09:00:01.000Z')
    expect(row.title).toBe('renamed')
  })

  it('skips an older-clock update', () => {
    reminderHandler.applyUpsert(ctx, 'rem_1', payload, { a: 2 })
    expect(
      reminderHandler.applyUpsert(ctx, 'rem_1', { ...payload, title: 'stale' }, { a: 1 })
    ).toBe('skipped')
  })

  it('reports concurrent edits as conflict', () => {
    reminderHandler.applyUpsert(ctx, 'rem_1', payload, { a: 1 })
    expect(
      reminderHandler.applyUpsert(ctx, 'rem_1', { ...payload, title: 'other' }, { b: 1 })
    ).toBe('conflict')
  })

  it('deletes a reminder', () => {
    reminderHandler.applyUpsert(ctx, 'rem_1', payload, { a: 1 })
    expect(reminderHandler.applyDelete(ctx, 'rem_1', { a: 2 })).toBe('applied')
    expect(db.select().from(reminders).all()).toHaveLength(0)
  })

  it('skips deleting an unknown reminder', () => {
    expect(reminderHandler.applyDelete(ctx, 'rem_missing', { a: 1 })).toBe('skipped')
  })

  it('seedUnclocked clocks and enqueues pre-existing rows', () => {
    db.insert(reminders)
      .values({
        id: 'rem_1',
        targetType: 'note',
        targetId: 'note_1',
        remindAt: '2026-08-03T09:00:00.000Z',
        status: 'pending'
      })
      .run()
    const queue = { enqueue: vi.fn() }
    expect(reminderHandler.seedUnclocked(db, 'device_a', queue as never)).toBe(1)
    expect(queue.enqueue).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- reminder-handler`
Expected: FAIL — cannot resolve `./reminder-handler`.

- [ ] **Step 3: Implement the handler**

Create `apps/desktop/src/main/sync/item-handlers/reminder-handler.ts`:

```ts
import { eq, isNull } from 'drizzle-orm'
import { reminders } from '@memry/db-schema/schema/reminders'
import { ReminderSyncPayloadSchema, type ReminderSyncPayload } from '@memry/contracts/sync-payloads'
import { ReminderChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import { utcNow } from '@memry/shared/utc'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('ReminderHandler')

/**
 * `triggeredAt` is intentionally never read from or written by the payload.
 * It records that THIS device showed an OS notification. Syncing it would make
 * a device that never displayed the reminder believe it already had, silently
 * swallowing the notification.
 */
class ReminderHandler extends BaseItemHandler<ReminderSyncPayload> {
  readonly type = 'reminder' as const
  readonly schema = ReminderSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: ReminderSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(reminders).where(eq(reminders.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveClock(existing.clock, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote reminder update, local is newer', { itemId })
          return 'skipped'
        }
        if (resolution.action === 'merge') {
          log.warn('Concurrent reminder edit, using last-write-wins', { itemId })
        }

        // triggeredAt is deliberately absent from this set — device-local.
        tx.update(reminders)
          .set({
            targetType: data.targetType ?? existing.targetType,
            targetId: data.targetId ?? existing.targetId,
            remindAt: data.remindAt ?? existing.remindAt,
            anchorId: data.anchorId ?? existing.anchorId,
            highlightText: data.highlightText ?? existing.highlightText,
            highlightStart: data.highlightStart ?? existing.highlightStart,
            highlightEnd: data.highlightEnd ?? existing.highlightEnd,
            title: data.title ?? existing.title,
            note: data.note ?? existing.note,
            status: data.status ?? existing.status,
            dismissedAt: data.dismissedAt ?? existing.dismissedAt,
            snoozedUntil: data.snoozedUntil ?? existing.snoozedUntil,
            modifiedAt: data.modifiedAt ?? now,
            clock: resolution.mergedClock,
            syncedAt: now
          })
          .where(eq(reminders.id, itemId))
          .run()

        ctx.emit(ReminderChannels.events.UPDATED, { id: itemId })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      tx.insert(reminders)
        .values({
          id: itemId,
          targetType: data.targetType ?? 'note',
          targetId: data.targetId ?? '',
          remindAt: data.remindAt ?? now,
          anchorId: data.anchorId ?? null,
          highlightText: data.highlightText ?? null,
          highlightStart: data.highlightStart ?? null,
          highlightEnd: data.highlightEnd ?? null,
          title: data.title ?? null,
          note: data.note ?? null,
          status: data.status ?? 'pending',
          dismissedAt: data.dismissedAt ?? null,
          snoozedUntil: data.snoozedUntil ?? null,
          clock: remoteClock,
          syncedAt: now,
          createdAt: data.createdAt ?? now,
          modifiedAt: data.modifiedAt ?? now
        })
        .run()

      ctx.emit(ReminderChannels.events.CREATED, { id: itemId })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(reminders).where(eq(reminders.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote reminder delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(reminders).where(eq(reminders.id, itemId)).run()
    ctx.emit(ReminderChannels.events.DELETED, { id: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(reminders).where(eq(reminders.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const reminder = db.select().from(reminders).where(eq(reminders.id, itemId)).get()
    if (!reminder) return null
    const { triggeredAt: _triggeredAt, ...syncable } = reminder
    return JSON.stringify(syncable)
  }

  markPushSynced(db: DrizzleDb, itemId: string): void {
    db.update(reminders).set({ syncedAt: utcNow() }).where(eq(reminders.id, itemId)).run()
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(reminders).where(isNull(reminders.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(reminders).set({ clock }).where(eq(reminders.id, item.id)).run()
      const { triggeredAt: _triggeredAt, ...syncable } = item
      queue.enqueue({
        type: 'reminder',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...syncable, clock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const reminderHandler = new ReminderHandler()
```

- [ ] **Step 4: Register the handler**

In `apps/desktop/src/main/sync/item-handlers/index.ts`, import `reminderHandler` and add `['reminder', reminderHandler]` to the handlers Map.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @memry/desktop test:main -- reminder-handler`
Expected: all 8 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/sync/item-handlers
git commit -m "feat(sync): add reminder sync handler with device-local triggeredAt"
```

---

### Task 5: Sync services and runtime wiring

**Files:**

- Create: `apps/desktop/src/main/sync/bookmark-sync.ts`
- Create: `apps/desktop/src/main/sync/reminder-sync.ts`
- Modify: `apps/desktop/src/main/sync/offline-clock.ts`
- Modify: `apps/desktop/src/main/sync/local-mutations.ts`
- Modify: `apps/desktop/src/main/sync/runtime.ts:25,155,322`
- Modify: `apps/desktop/src/main/sync/manifest-check.ts:8,177-180`

**Interfaces:**

- Consumes: `bookmarkHandler` (Task 3), `reminderHandler` (Task 4).
- Produces: `initBookmarkSyncService`, `getBookmarkSyncService`, `resetBookmarkSyncService`, `initReminderSyncService`, `getReminderSyncService`, `resetReminderSyncService`; `incrementBookmarkClockOffline(db, bookmarkId)`, `incrementReminderClockOffline(db, reminderId)`. Registry entries make `enqueueCreate` / `enqueueUpdate` / `enqueueDelete` reachable for types `'bookmark'` and `'reminder'`.

- [ ] **Step 1: Create the bookmark sync service**

Create `apps/desktop/src/main/sync/bookmark-sync.ts` — structurally identical to `filter-sync.ts`:

```ts
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import type * as schema from '@memry/db-schema/data-schema'
import { bookmarks } from '@memry/db-schema/schema/bookmarks'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'

type DrizzleDb = BetterSQLite3Database<typeof schema>

interface BookmarkSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: BookmarkSyncService | null = null

export function initBookmarkSyncService(deps: BookmarkSyncDeps): BookmarkSyncService {
  instance = new BookmarkSyncService(deps)
  return instance
}

export function getBookmarkSyncService(): BookmarkSyncService | null {
  return instance
}

export function resetBookmarkSyncService(): void {
  instance = null
}

export class BookmarkSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], [string]>

  constructor(deps: BookmarkSyncDeps) {
    this.controller = new RecordSyncController({
      type: 'bookmark',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (bookmarkId) =>
        deps.db.select().from(bookmarks).where(eq(bookmarks.id, bookmarkId)).get() as
          | Record<string, unknown>
          | undefined,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)

        deps.db.update(bookmarks).set({ clock: newClock }).where(eq(bookmarks.id, itemId)).run()

        return { ...local, clock: newClock }
      },
      serialize: (local) => local,
      buildDeletePayload: ({ extra, deviceId }) => withIncrementedClock(extra[0], deviceId)
    })
  }

  enqueueCreate(bookmarkId: string): void {
    this.controller.enqueueCreate(bookmarkId)
  }

  enqueueUpdate(bookmarkId: string): void {
    this.controller.enqueueUpdate(bookmarkId)
  }

  enqueueDelete(bookmarkId: string, snapshotPayload: string): void {
    this.controller.enqueueDelete(bookmarkId, snapshotPayload)
  }
}
```

- [ ] **Step 2: Create the reminder sync service**

Create `apps/desktop/src/main/sync/reminder-sync.ts` — the same shape, with one difference: `serialize` strips `triggeredAt` so a local change never pushes the device-local field.

```ts
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import type * as schema from '@memry/db-schema/data-schema'
import { reminders } from '@memry/db-schema/schema/reminders'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'

type DrizzleDb = BetterSQLite3Database<typeof schema>

interface ReminderSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: ReminderSyncService | null = null

export function initReminderSyncService(deps: ReminderSyncDeps): ReminderSyncService {
  instance = new ReminderSyncService(deps)
  return instance
}

export function getReminderSyncService(): ReminderSyncService | null {
  return instance
}

export function resetReminderSyncService(): void {
  instance = null
}

export class ReminderSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], [string]>

  constructor(deps: ReminderSyncDeps) {
    this.controller = new RecordSyncController({
      type: 'reminder',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (reminderId) =>
        deps.db.select().from(reminders).where(eq(reminders.id, reminderId)).get() as
          | Record<string, unknown>
          | undefined,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)

        deps.db.update(reminders).set({ clock: newClock }).where(eq(reminders.id, itemId)).run()

        return { ...local, clock: newClock }
      },
      // triggeredAt is device-local: never push it.
      serialize: (local) => {
        const { triggeredAt: _triggeredAt, ...syncable } = local
        return syncable
      },
      buildDeletePayload: ({ extra, deviceId }) => withIncrementedClock(extra[0], deviceId)
    })
  }

  enqueueCreate(reminderId: string): void {
    this.controller.enqueueCreate(reminderId)
  }

  enqueueUpdate(reminderId: string): void {
    this.controller.enqueueUpdate(reminderId)
  }

  enqueueDelete(reminderId: string, snapshotPayload: string): void {
    this.controller.enqueueDelete(reminderId, snapshotPayload)
  }
}
```

- [ ] **Step 3: Add the offline clock helpers**

In `apps/desktop/src/main/sync/offline-clock.ts`, import both tables and append, after `incrementFilterClockOffline`:

```ts
export function incrementBookmarkClockOffline(db: DataDb, bookmarkId: string): void {
  try {
    const bookmark = db.select().from(bookmarks).where(eq(bookmarks.id, bookmarkId)).get()
    if (!bookmark) return

    const existingClock = (bookmark.clock as VectorClock) ?? {}
    const newClock = increment(existingClock, OFFLINE_DEVICE_KEY)

    db.update(bookmarks).set({ clock: newClock }).where(eq(bookmarks.id, bookmarkId)).run()

    log.debug('Incremented offline bookmark clock', { bookmarkId })
  } catch (err) {
    log.warn('Failed to increment offline bookmark clock', { bookmarkId, error: err })
  }
}

export function incrementReminderClockOffline(db: DataDb, reminderId: string): void {
  try {
    const reminder = db.select().from(reminders).where(eq(reminders.id, reminderId)).get()
    if (!reminder) return

    const existingClock = (reminder.clock as VectorClock) ?? {}
    const newClock = increment(existingClock, OFFLINE_DEVICE_KEY)

    db.update(reminders).set({ clock: newClock }).where(eq(reminders.id, reminderId)).run()

    log.debug('Incremented offline reminder clock', { reminderId })
  } catch (err) {
    log.warn('Failed to increment offline reminder clock', { reminderId, error: err })
  }
}
```

- [ ] **Step 4: Add the local-mutations registry entries**

In `apps/desktop/src/main/sync/local-mutations.ts`, add the two imports (`getBookmarkSyncService`, `getReminderSyncService`) plus the two offline-clock helpers, then add these entries to `createSyncAdapterRegistry([...])`:

```ts
  {
    type: 'bookmark',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        const service = getBookmarkSyncService()
        if (service) {
          service.enqueueCreate(itemId)
          return
        }

        incrementBookmarkClockOffline(getDatabase(), itemId)
      },
      enqueueUpdate(itemId: string): void {
        const service = getBookmarkSyncService()
        if (service) {
          service.enqueueUpdate(itemId)
          return
        }

        incrementBookmarkClockOffline(getDatabase(), itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        if (!snapshotPayload) return
        getBookmarkSyncService()?.enqueueDelete(itemId, snapshotPayload)
      }
    }
  },
  {
    type: 'reminder',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        const service = getReminderSyncService()
        if (service) {
          service.enqueueCreate(itemId)
          return
        }

        incrementReminderClockOffline(getDatabase(), itemId)
      },
      enqueueUpdate(itemId: string): void {
        const service = getReminderSyncService()
        if (service) {
          service.enqueueUpdate(itemId)
          return
        }

        incrementReminderClockOffline(getDatabase(), itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        if (!snapshotPayload) return
        getReminderSyncService()?.enqueueDelete(itemId, snapshotPayload)
      }
    }
  },
```

- [ ] **Step 5: Wire runtime setup and teardown**

In `apps/desktop/src/main/sync/runtime.ts`:

- Near line 25, add the imports:

```ts
import { initBookmarkSyncService, resetBookmarkSyncService } from './bookmark-sync'
import { initReminderSyncService, resetReminderSyncService } from './reminder-sync'
```

- Near line 155, in teardown, alongside `resetFilterSyncService()`:

```ts
resetBookmarkSyncService()
resetReminderSyncService()
```

- Near line 322, in setup, alongside the `filterSync` init:

```ts
const bookmarkSync = initBookmarkSyncService({ queue, db: runtimeSyncDb, getDeviceId })
const reminderSync = initReminderSyncService({ queue, db: runtimeSyncDb, getDeviceId })
```

Register both in the same `createSyncAdapterRegistry([...])` call that already lists `filterSync`, following the exact shape used for filters in that call.

- [ ] **Step 6: Add manifest-check local items**

In `apps/desktop/src/main/sync/manifest-check.ts`, import both tables at line 8, then after the `syncedFilters` block (lines 177-180) add:

```ts
const syncedBookmarks = db.select().from(bookmarks).where(isNotNull(bookmarks.clock)).all()
for (const b of syncedBookmarks) {
  addLocalItem({ id: b.id, type: 'bookmark', payload: JSON.stringify(b) })
}

const syncedReminders = db.select().from(reminders).where(isNotNull(reminders.clock)).all()
for (const r of syncedReminders) {
  const { triggeredAt: _triggeredAt, ...syncable } = r
  addLocalItem({ id: r.id, type: 'reminder', payload: JSON.stringify(syncable) })
}
```

Without these blocks, existing rows never reach other devices.

- [ ] **Step 7: Typecheck and run the sync suite**

Run: `pnpm typecheck && pnpm --filter @memry/desktop test:main -- sync`
Expected: clean typecheck, suite PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/main/sync
git commit -m "feat(sync): wire bookmark and reminder sync services into runtime"
```

---

### Task 6: Bookmark mutations enqueue to sync

Registry wiring alone does nothing — the mutation code must call the enqueue functions or local edits write to the DB and never sync.

**Files:**

- Modify: `apps/desktop/src/main/ipc/bookmarks-handlers.ts`
- Test: `apps/desktop/src/main/ipc/bookmarks-handlers.test.ts`

**Interfaces:**

- Consumes: `bookmarkSyncId` (Task 1); local-mutations registry entries for `'bookmark'` (Task 5).

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/main/ipc/bookmarks-handlers.test.ts`:

```ts
describe('bookmark sync enqueue', () => {
  it('creates bookmarks with a deterministic id', async () => {
    const result = await invoke('bookmarks:create', { itemType: 'note', itemId: 'note_1' })
    expect(result.bookmark.id).toBe('bmk_note_note_1')
  })

  it('enqueues a create on bookmark create', async () => {
    await invoke('bookmarks:create', { itemType: 'note', itemId: 'note_1' })
    expect(enqueueCreateSpy).toHaveBeenCalledWith('bookmark', 'bmk_note_note_1')
  })

  it('enqueues a delete with a snapshot payload on bookmark delete', async () => {
    await invoke('bookmarks:create', { itemType: 'note', itemId: 'note_1' })
    await invoke('bookmarks:delete', { id: 'bmk_note_note_1' })
    expect(enqueueDeleteSpy).toHaveBeenCalledWith('bookmark', 'bmk_note_note_1', expect.any(String))
  })

  it('enqueues an update per row on reorder', async () => {
    await invoke('bookmarks:create', { itemType: 'note', itemId: 'note_1' })
    await invoke('bookmarks:create', { itemType: 'note', itemId: 'note_2' })
    enqueueUpdateSpy.mockClear()

    await invoke('bookmarks:reorder', { bookmarkIds: ['bmk_note_note_2', 'bmk_note_note_1'] })

    expect(enqueueUpdateSpy).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @memry/desktop test:main -- bookmarks-handlers`
Expected: FAIL — ids are nanoids and no enqueue is called.

- [ ] **Step 3: Use the deterministic id and enqueue on every mutation**

In `apps/desktop/src/main/ipc/bookmarks-handlers.ts`:

- Import `bookmarkSyncId` from `@memry/contracts/bookmark-types` and the local-mutations enqueue helpers.
- In the `CREATE` handler (and the `TOGGLE` create branch and `BULK_CREATE`), replace the generated id with `bookmarkSyncId(input.itemType, input.itemId)`, then call `enqueueCreate('bookmark', id)` after the row is inserted.
- In `DELETE`, `TOGGLE`'s delete branch, and `BULK_DELETE`, capture the row **before** deleting, then call `enqueueDelete('bookmark', id, JSON.stringify(rowSnapshot))` after the delete succeeds. The snapshot is required — `enqueueDelete` no-ops without it.
- In `REORDER`, call `enqueueUpdate('bookmark', id)` once per id in `input.bookmarkIds` after `reorderBookmarks` commits.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @memry/desktop test:main -- bookmarks-handlers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/ipc/bookmarks-handlers.ts apps/desktop/src/main/ipc/bookmarks-handlers.test.ts
git commit -m "feat(sync): enqueue bookmark mutations for sync"
```

---

### Task 7: app-core reminders service onMutate seam

`packages/app-core` cannot import desktop sync code without breaking the architecture boundary, so the enqueue is injected.

**Files:**

- Modify: `packages/app-core/src/reminders.ts:111-259`
- Modify: `apps/desktop/src/main/vault/notes-crud.ts:53`
- Modify: `apps/desktop/src/main/sync/crdt-writeback.ts`
- Test: `packages/app-core/src/reminders.test.ts`

**Interfaces:**

- Produces: `RemindersServiceHooks` — `{ onMutate?: (op: 'create' | 'update' | 'delete', id: string, snapshot?: string) => void }`; `createRemindersService(dataDb: DataDb, hooks?: RemindersServiceHooks): RemindersService` (the `hooks` parameter is optional, so every existing call site keeps compiling).

- [ ] **Step 1: Write the failing test**

Append to `packages/app-core/src/reminders.test.ts`:

```ts
describe('createRemindersService hooks', () => {
  it('calls onMutate with create when a reminder is created', async () => {
    const onMutate = vi.fn()
    const service = createRemindersService(db, { onMutate })

    const row = await service.create({
      targetType: 'note',
      targetId: 'note_1',
      remindAt: '2026-08-03T09:00:00.000Z'
    })

    expect(onMutate).toHaveBeenCalledWith('create', row.id, undefined)
  })

  it('calls onMutate with update when a reminder is updated', async () => {
    const onMutate = vi.fn()
    const service = createRemindersService(db, { onMutate })
    const row = await service.create({
      targetType: 'note',
      targetId: 'note_1',
      remindAt: '2026-08-03T09:00:00.000Z'
    })
    onMutate.mockClear()

    await service.update({ id: row.id, remindAt: '2026-08-04T09:00:00.000Z' })

    expect(onMutate).toHaveBeenCalledWith('update', row.id, undefined)
  })

  it('calls onMutate with delete and a snapshot before removal', async () => {
    const onMutate = vi.fn()
    const service = createRemindersService(db, { onMutate })
    const row = await service.create({
      targetType: 'note',
      targetId: 'note_1',
      remindAt: '2026-08-03T09:00:00.000Z'
    })
    onMutate.mockClear()

    await service.delete(row.id)

    expect(onMutate).toHaveBeenCalledWith('delete', row.id, expect.any(String))
  })

  it('works without hooks (existing call sites)', async () => {
    const service = createRemindersService(db)
    await expect(
      service.create({
        targetType: 'note',
        targetId: 'note_1',
        remindAt: '2026-08-03T09:00:00.000Z'
      })
    ).resolves.toBeDefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @memry/app-core test -- reminders`
Expected: FAIL — `createRemindersService` takes one argument.

- [ ] **Step 3: Add the hooks parameter**

In `packages/app-core/src/reminders.ts`:

```ts
export interface RemindersServiceHooks {
  /**
   * Called after a reminder row is written. Desktop wires this to the sync
   * queue; `app-core` must not import desktop sync code directly (architecture
   * boundary). For 'delete', `snapshot` is the JSON row captured BEFORE
   * removal — the sync delete payload cannot be rebuilt afterwards.
   */
  onMutate?: (op: 'create' | 'update' | 'delete', id: string, snapshot?: string) => void
}

export function createRemindersService(
  dataDb: DataDb,
  hooks?: RemindersServiceHooks
): RemindersService {
```

Then call `hooks?.onMutate(...)` at each write site in the service:

- after the insert (line ~122): `hooks?.onMutate?.('create', row.id)`
- after each update (lines ~165, ~221, ~235, ~248): `hooks?.onMutate?.('update', row.id)`
- in `delete` (line ~258): capture the row first, then call `hooks?.onMutate?.('delete', id, JSON.stringify(row))` before `dataDb.delete(...)` runs.

- [ ] **Step 4: Wire the desktop call sites**

In `apps/desktop/src/main/vault/notes-crud.ts` and `apps/desktop/src/main/sync/crdt-writeback.ts`, pass hooks that forward to the local-mutations registry:

```ts
createRemindersService(db, {
  onMutate: (op, id, snapshot) => {
    if (op === 'create') enqueueCreate('reminder', id)
    else if (op === 'update') enqueueUpdate('reminder', id)
    else enqueueDelete('reminder', id, snapshot)
  }
})
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @memry/app-core test -- reminders && pnpm check:architecture`
Expected: PASS, architecture boundary clean.

- [ ] **Step 6: Commit**

```bash
git add packages/app-core apps/desktop/src/main/vault/notes-crud.ts apps/desktop/src/main/sync/crdt-writeback.ts
git commit -m "feat(sync): add onMutate seam to app-core reminders service"
```

---

### Task 8: Main-process reminder mutations enqueue

The second write path. The scheduler's `triggered` transition must **not** enqueue; dismiss and snooze must.

**Files:**

- Modify: `apps/desktop/src/main/lib/reminders.ts:370,419,448,618,656,693,741`
- Test: `apps/desktop/src/main/lib/reminders.test.ts`

**Interfaces:**

- Consumes: local-mutations registry entries for `'reminder'` (Task 5).

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/main/lib/reminders.test.ts`:

```ts
describe('reminder sync enqueue', () => {
  it('enqueues a create when a reminder is created', async () => {
    const row = await createReminder({
      targetType: 'note',
      targetId: 'note_1',
      remindAt: '2026-08-03T09:00:00.000Z'
    })
    expect(enqueueCreateSpy).toHaveBeenCalledWith('reminder', row.id)
  })

  it('enqueues an update when a reminder is dismissed', async () => {
    const row = await createReminder({
      targetType: 'note',
      targetId: 'note_1',
      remindAt: '2026-08-03T09:00:00.000Z'
    })
    enqueueUpdateSpy.mockClear()

    await dismissReminder(row.id)

    expect(enqueueUpdateSpy).toHaveBeenCalledWith('reminder', row.id)
  })

  it('enqueues an update when a reminder is snoozed', async () => {
    const row = await createReminder({
      targetType: 'note',
      targetId: 'note_1',
      remindAt: '2026-08-03T09:00:00.000Z'
    })
    enqueueUpdateSpy.mockClear()

    await snoozeReminder({ id: row.id, snoozedUntil: '2026-08-03T10:00:00.000Z' })

    expect(enqueueUpdateSpy).toHaveBeenCalledWith('reminder', row.id)
  })

  it('does NOT enqueue when the scheduler marks a reminder triggered', async () => {
    const row = await createReminder({
      targetType: 'note',
      targetId: 'note_1',
      remindAt: '2026-08-03T09:00:00.000Z'
    })
    enqueueUpdateSpy.mockClear()

    await markReminderTriggered(row.id)

    expect(enqueueUpdateSpy).not.toHaveBeenCalled()
  })

  it('enqueues a delete with a snapshot when a reminder is deleted', async () => {
    const row = await createReminder({
      targetType: 'note',
      targetId: 'note_1',
      remindAt: '2026-08-03T09:00:00.000Z'
    })

    await deleteReminder(row.id)

    expect(enqueueDeleteSpy).toHaveBeenCalledWith('reminder', row.id, expect.any(String))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @memry/desktop test:main -- lib/reminders`
Expected: FAIL — no enqueue calls.

- [ ] **Step 3: Add the enqueue calls**

In `apps/desktop/src/main/lib/reminders.ts`:

- After the insert at line ~370: `enqueueCreate('reminder', id)`
- After the update at line ~419: `enqueueUpdate('reminder', input.id)`
- At the delete at line ~448: capture the row first, then `enqueueDelete('reminder', id, JSON.stringify(row))`
- At lines ~618, ~656, ~693, ~741: inspect each update. Any write that sets `status`, `dismissedAt`, or `snoozedUntil` gets `enqueueUpdate('reminder', id)`. The write that sets **only** `triggeredAt` gets **no** enqueue — add this comment above it:

```ts
// triggeredAt is device-local (see reminder-handler): each device shows its
// own notification, so this transition must never push.
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @memry/desktop test:main -- lib/reminders`
Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/lib/reminders.ts apps/desktop/src/main/lib/reminders.test.ts
git commit -m "feat(sync): enqueue reminder mutations except device-local triggeredAt"
```

---

### Task 9: note_date deterministic id and loop guard

The riskiest task. A regression here is a sync loop, not a visible bug.

**Files:**

- Modify: `apps/desktop/src/main/notes/note-date-reminders.ts:40-62`
- Test: `apps/desktop/src/main/notes/note-date-reminders.test.ts`

**Interfaces:**

- Consumes: `noteDateReminderId` (Task 1); `RemindersServiceHooks` (Task 7).

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/main/notes/note-date-reminders.test.ts`:

```ts
describe('note_date sync convergence', () => {
  const markdown = 'See [[date:2026-08-03T09:00:00.000Z|anchor_1|1h]] for details'

  it('creates the reminder with a deterministic id', async () => {
    await syncNoteDateReminders('note_1', markdown, service)
    const rows = (await service.list({ targetType: 'note_date', targetId: 'note_1' })).reminders
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('rem_nd_note_1_anchor_1')
  })

  it('converges with a row already synced from another device', async () => {
    // Device A's row arrives via sync first.
    await service.create({
      id: 'rem_nd_note_1_anchor_1',
      targetType: 'note_date',
      targetId: 'note_1',
      anchorId: 'anchor_1',
      remindAt: '2026-08-03T09:00:00.000Z'
    })

    // Device B then derives the same pill from synced note content.
    await syncNoteDateReminders('note_1', markdown, service)

    const rows = (await service.list({ targetType: 'note_date', targetId: 'note_1' })).reminders
    expect(rows).toHaveLength(1)
  })

  it('enqueues nothing on a re-run with unchanged markdown (loop guard)', async () => {
    await syncNoteDateReminders('note_1', markdown, service)
    onMutate.mockClear()

    await syncNoteDateReminders('note_1', markdown, service)

    expect(onMutate).not.toHaveBeenCalled()
  })

  it('does not reset a dismissed status when the note is re-written', async () => {
    await syncNoteDateReminders('note_1', markdown, service)
    await service.update({ id: 'rem_nd_note_1_anchor_1', status: 'dismissed' })

    await syncNoteDateReminders('note_1', markdown, service)

    const row = await service.get('rem_nd_note_1_anchor_1')
    expect(row.status).toBe('dismissed')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @memry/desktop test:main -- note-date-reminders`
Expected: FAIL — created ids are nanoids.

- [ ] **Step 3: Use the deterministic id on create**

In `apps/desktop/src/main/notes/note-date-reminders.ts`, import `noteDateReminderId` and pass an explicit id in the create branch (around line 42):

```ts
    if (!row) {
      await service.create({
        id: noteDateReminderId(noteId, anchorId),
        targetType: 'note_date',
        targetId: noteId,
        anchorId,
        remindAt: want.remindAt
      })
    } else if (row.remindAt !== want.remindAt) {
```

The existing `else if (row.remindAt !== want.remindAt)` guard and the "delete only when not desired" loop are already write-only-on-change — do **not** restructure them. That guard is what stops two devices from ping-ponging enqueues forever.

If `CreateReminderInput` does not accept an `id`, add it as an optional field that falls back to the generated id when absent.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @memry/desktop test:main -- note-date-reminders`
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/notes/note-date-reminders.ts apps/desktop/src/main/notes/note-date-reminders.test.ts
git commit -m "feat(sync): converge derived note_date reminders on a deterministic id"
```

---

### Task 10: Full verification and docs gate

**Files:**

- Modify: `apps/docs/src/**` (whatever `docs:impact` flags)

- [ ] **Step 1: Run the full gate**

Do **NOT** run `db:generate` for the data DB (Drizzle snapshots broken past 0021 — migration 0040 is hand-written and must stay that way).

```bash
pnpm --filter @memry/desktop db:push
pnpm ipc:generate && pnpm ipc:check
pnpm check:contracts && pnpm check:architecture
pnpm typecheck
pnpm lint
pnpm test:desktop && pnpm test:sync-server
git diff --check
```

Expected: all green. If `better-sqlite3` raises `ERR_DLOPEN_FAILED`, run `pnpm --filter @memry/desktop rebuild:node` — that is a NODE_MODULE_VERSION mismatch, not a code failure.

- [ ] **Step 2: Run the docs gate**

```bash
pnpm docs:impact --base origin/main --strict
```

If it reports `missing-docs`, update real pages under `apps/docs/src/**` (or run `pnpm docs:ai-update --base origin/main`), then re-run the check and `pnpm docs:build`.

- [ ] **Step 3: Two-profile manual verification**

Run `pnpm --filter @memry/desktop dev:a` and `pnpm --filter @memry/desktop dev:b` against the same account, then confirm:

1. Bookmark a note on A → it appears in B's sidebar.
2. Reorder bookmarks on A → order matches on B.
3. Remove a bookmark on A → it disappears on B.
4. Set a reminder on A → it exists on B and fires there.
5. Dismiss a reminder on A → B does not fire it.
6. Add a date pill to a note on A → exactly one `note_date` reminder exists on B, not two.
7. Leave both idle for five minutes → the sync log shows no repeating bookmark/reminder push cycle (the loop-guard check).

Item 6 and item 7 are the ones that would catch a regression in Task 9.

- [ ] **Step 4: Commit any docs changes**

```bash
git add apps/docs
git commit -m "docs: cover bookmark and reminder sync"
```

---

## Self-Review Notes

**Spec coverage:** deterministic ids → Tasks 1, 2, 6, 9. Reminder field split incl. device-local `triggeredAt` → Tasks 1, 4, 5, 8. `note_date` convergence → Task 9. Enqueue seam (both write paths) → Tasks 6, 7, 8. Backward compat → Task 2 migration plus the frozen-legacy-array constraint in Task 1. Telemetry → Task 1. Tests → each task. Verification → Task 10.

**Known follow-ups deliberately excluded:** highlight-offset drift (pre-existing, spec Residual Risks); reorder enqueue churn (acceptable at realistic bookmark counts).
