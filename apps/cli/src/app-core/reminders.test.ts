import assert from 'node:assert/strict'
import test from 'node:test'

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as dataSchema from '@memry/db-schema/data-schema'

import { reminderTargetType } from '@memry/contracts/reminder-types'
import { createRemindersService, type RemindersServiceHooks } from '@memry/app-core/reminders'
import type { DataDb } from './database.ts'

test('reminder target types: canonical set is exactly the five supported targets', () => {
  assert.deepEqual(Object.values(reminderTargetType).sort(), [
    'highlight',
    'journal',
    'note',
    'note_date',
    'task'
  ])
})

// Builds the reminders table directly instead of going through
// openDatabases()/runMigrations(): findWorkspaceRoot() walks up from the
// current file looking for a directory literally named "memry", which in a
// git worktree checkout (<repo>/.worktrees/<branch>/...) overshoots the
// worktree and lands on the outer main-checkout repo root — a pre-existing,
// unrelated environment issue (see bookmarks.test.ts). Building the table
// in-memory keeps this test independent of that.
function createInMemoryDataDb(): DataDb {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE reminders (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      remind_at TEXT NOT NULL,
      highlight_text TEXT,
      highlight_start INTEGER,
      highlight_end INTEGER,
      anchor_id TEXT,
      title TEXT,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      triggered_at TEXT,
      dismissed_at TEXT,
      snoozed_until TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      modified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      clock TEXT,
      synced_at TEXT
    );
  `)
  return drizzle(sqlite, { schema: dataSchema }) as DataDb
}

function collectMutations(): {
  hooks: RemindersServiceHooks
  calls: Array<{ op: 'create' | 'update' | 'delete'; id: string; snapshot?: string }>
} {
  const calls: Array<{ op: 'create' | 'update' | 'delete'; id: string; snapshot?: string }> = []
  return {
    calls,
    hooks: {
      onMutate: (op, id, snapshot) => {
        calls.push({ op, id, snapshot })
      }
    }
  }
}

// The desktop write paths (notes-crud.ts, crdt-writeback.ts) inject onMutate
// so reminder writes reach the sync queue — app-core cannot import desktop
// sync code directly (architecture boundary), so the enqueue is injected.
test('createRemindersService: onMutate fires create on create', async () => {
  const dataDb = createInMemoryDataDb()
  const { hooks, calls } = collectMutations()
  const service = createRemindersService(dataDb, hooks)

  const row = await service.create({
    targetType: 'note',
    targetId: 'note_1',
    remindAt: '2026-08-03T09:00:00.000Z'
  })

  assert.deepEqual(calls, [{ op: 'create', id: row.id, snapshot: undefined }])
})

test('createRemindersService: onMutate fires update on update', async () => {
  const dataDb = createInMemoryDataDb()
  const { hooks, calls } = collectMutations()
  const service = createRemindersService(dataDb, hooks)
  const row = await service.create({
    targetType: 'note',
    targetId: 'note_1',
    remindAt: '2026-08-03T09:00:00.000Z'
  })
  calls.length = 0

  await service.update({ id: row.id, remindAt: '2026-08-04T09:00:00.000Z' })

  assert.deepEqual(calls, [{ op: 'update', id: row.id, snapshot: undefined }])
})

test('createRemindersService: onMutate fires update on dismiss, snooze, and bulkDismiss', async () => {
  const dataDb = createInMemoryDataDb()
  const { hooks, calls } = collectMutations()
  const service = createRemindersService(dataDb, hooks)
  const a = await service.create({
    targetType: 'note',
    targetId: 'note_1',
    remindAt: '2026-08-03T09:00:00.000Z'
  })
  const b = await service.create({
    targetType: 'note',
    targetId: 'note_2',
    remindAt: '2026-08-03T09:00:00.000Z'
  })
  calls.length = 0

  await service.dismiss(a.id)
  assert.deepEqual(calls, [{ op: 'update', id: a.id, snapshot: undefined }])
  calls.length = 0

  await service.snooze(a.id, '2026-08-05T09:00:00.000Z')
  assert.deepEqual(calls, [{ op: 'update', id: a.id, snapshot: undefined }])
  calls.length = 0

  await service.bulkDismiss([b.id])
  assert.deepEqual(calls, [{ op: 'update', id: b.id, snapshot: undefined }])
})

test('createRemindersService: onMutate fires delete with a non-empty snapshot that omits triggeredAt', async () => {
  const dataDb = createInMemoryDataDb()
  const { hooks, calls } = collectMutations()
  const service = createRemindersService(dataDb, hooks)
  const row = await service.create({
    targetType: 'note',
    targetId: 'note_1',
    remindAt: '2026-08-03T09:00:00.000Z'
  })
  calls.length = 0

  const deleted = await service.delete(row.id)

  assert.equal(deleted, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].op, 'delete')
  assert.equal(calls[0].id, row.id)
  assert.ok(
    calls[0].snapshot,
    'delete snapshot must be non-empty so downstream enqueueDelete does not no-op'
  )
  const parsedSnapshot = JSON.parse(calls[0].snapshot as string) as Record<string, unknown>
  assert.equal('triggeredAt' in parsedSnapshot, false)
  assert.equal(parsedSnapshot.id, row.id)
})

// note_date rows are re-derived on every device from the note's date pills, so
// the reconciler has to name the row itself (noteDateReminderId) or one pill
// becomes two forever-diverging rows. Every other caller omits `id`.
test('createRemindersService: create honours an explicit id and falls back to a generated one', async () => {
  const dataDb = createInMemoryDataDb()
  const { hooks, calls } = collectMutations()
  const service = createRemindersService(dataDb, hooks)

  const explicit = await service.create({
    id: 'rem_nd_note_1_dm_1',
    targetType: 'note_date',
    targetId: 'note_1',
    anchorId: 'dm_1',
    remindAt: '2026-08-03T09:00:00.000Z'
  })
  assert.equal(explicit.id, 'rem_nd_note_1_dm_1')
  assert.deepEqual(calls, [{ op: 'create', id: 'rem_nd_note_1_dm_1', snapshot: undefined }])

  const generated = await service.create({
    targetType: 'note',
    targetId: 'note_1',
    remindAt: '2026-08-03T09:00:00.000Z'
  })
  assert.match(generated.id, /^reminder_/)
})

test('createRemindersService: works without hooks (existing call sites keep compiling and behaving)', async () => {
  const dataDb = createInMemoryDataDb()
  const service = createRemindersService(dataDb)

  const row = await service.create({
    targetType: 'note',
    targetId: 'note_1',
    remindAt: '2026-08-03T09:00:00.000Z'
  })
  assert.ok(row.id)

  const updated = await service.update({ id: row.id, remindAt: '2026-08-04T09:00:00.000Z' })
  assert.ok(updated)

  const deleted = await service.delete(row.id)
  assert.equal(deleted, true)
})
