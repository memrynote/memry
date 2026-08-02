import assert from 'node:assert/strict'
import test from 'node:test'

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as dataSchema from '@memry/db-schema/data-schema'

import { createBookmarksService } from './bookmarks.ts'
import type { DataDb } from './database.ts'

// Builds the bookmarks table directly instead of going through
// openDatabases()/runMigrations(): findWorkspaceRoot() walks up from the
// current file looking for a directory literally named "memry", which in a
// git worktree checkout (<repo>/.worktrees/<branch>/...) overshoots the
// worktree and lands on the outer main-checkout repo root — a pre-existing,
// unrelated environment issue, not something this fix touches. Building the
// table in-memory keeps this test independent of that.
function createInMemoryDataDb(): DataDb {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE bookmarks (
      id TEXT PRIMARY KEY,
      item_type TEXT NOT NULL,
      item_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      clock TEXT,
      synced_at TEXT
    );
    CREATE UNIQUE INDEX idx_bookmarks_unique_item ON bookmarks (item_type, item_id);
  `)
  return drizzle(sqlite, { schema: dataSchema }) as DataDb
}

// Bookmark row ids must be deterministic (`bmk_<itemType>_<itemId>`), not random
// nanoids. Two devices bookmarking the same item offline would otherwise mint
// two different ids for one logical bookmark and collide on
// idx_bookmarks_unique_item at sync-pull time — the exact bug migration 0040
// exists to clean up. See packages/contracts/src/bookmark-types.ts.
test('bookmarks service mints deterministic ids on add, toggle, and bulkCreate', async () => {
  const dataDb = createInMemoryDataDb()
  const bookmarksService = createBookmarksService(dataDb)

  const added = await bookmarksService.add({ itemType: 'note', itemId: 'note-1' })
  assert.equal(added.id, 'bmk_note_note-1')

  // toggle()'s create branch funnels through add() — must inherit the fix,
  // not mint its own id.
  const toggled = await bookmarksService.toggle({ itemType: 'task', itemId: 'task-1' })
  assert.equal(toggled.bookmarked, true)
  assert.equal(toggled.bookmark?.id, 'bmk_task_task-1')

  // bulkCreate() also funnels through add() per item.
  const bulkCreated = await bookmarksService.bulkCreate([
    { itemType: 'note', itemId: 'note-2' },
    { itemType: 'template', itemId: 'template-1' }
  ])
  assert.deepEqual(
    bulkCreated.map((bookmark) => bookmark.id),
    ['bmk_note_note-2', 'bmk_template_template-1']
  )

  // Re-adding the same item is idempotent and returns the same deterministic
  // row rather than minting a second one.
  const reAdded = await bookmarksService.add({ itemType: 'note', itemId: 'note-1' })
  assert.equal(reAdded.id, added.id)
})
