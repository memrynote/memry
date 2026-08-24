import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, asSyncDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { bookmarks } from '@memry/db-schema/schema/bookmarks'
import type { BookmarkSyncPayload } from '@memry/contracts/sync-payloads'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { bookmarkHandler } from '@memry/sync-client/item-handlers/bookmark-handler'
import type { ApplyContext } from '@memry/sync-client/item-handlers/types'
import { makeCtx } from '@tests/utils/fixtures/sync-item-handlers'

describe('bookmarkHandler', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = makeCtx(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  const payload: BookmarkSyncPayload = {
    itemType: 'note',
    itemId: 'note_1',
    position: 0,
    createdAt: '2026-08-02T00:00:00.000Z'
  }

  it('inserts a new bookmark', () => {
    const result = bookmarkHandler.applyUpsert(ctx, 'bmk_note_note_1', payload, { a: 1 })
    expect(result).toBe('applied')

    const row = testDb.db.select().from(bookmarks).where(eq(bookmarks.id, 'bmk_note_note_1')).get()
    expect(row?.itemId).toBe('note_1')
    expect(row?.clock).toEqual({ a: 1 })
  })

  it('skips inserting when the payload has no itemId', () => {
    const result = bookmarkHandler.applyUpsert(
      ctx,
      'bmk_note_note_1',
      { ...payload, itemId: undefined },
      { a: 1 }
    )
    expect(result).toBe('skipped')
    expect(testDb.db.select().from(bookmarks).all()).toHaveLength(0)
  })

  it('skips inserting when the payload has no itemType', () => {
    const result = bookmarkHandler.applyUpsert(
      ctx,
      'bmk_note_note_1',
      { ...payload, itemType: undefined },
      { a: 1 }
    )
    expect(result).toBe('skipped')
    expect(testDb.db.select().from(bookmarks).all()).toHaveLength(0)
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

    const row = testDb.db.select().from(bookmarks).where(eq(bookmarks.id, 'bmk_note_note_1')).get()
    expect(row?.position).toBe(5)
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

    const row = testDb.db.select().from(bookmarks).where(eq(bookmarks.id, 'bmk_note_note_1')).get()
    expect(row?.position).toBe(0)
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
    expect(testDb.db.select().from(bookmarks).all()).toHaveLength(0)
  })

  it('skips deleting an unknown bookmark', () => {
    expect(bookmarkHandler.applyDelete(ctx, 'bmk_note_missing', { a: 1 })).toBe('skipped')
  })

  it('seedUnclocked clocks pre-existing rows and enqueues them', () => {
    testDb.db
      .insert(bookmarks)
      .values({ id: 'bmk_note_note_1', itemType: 'note', itemId: 'note_1', position: 0 })
      .run()

    const queue = new SyncQueueManager(asSyncDb(testDb.db))
    const count = bookmarkHandler.seedUnclocked(ctx.db, 'device-a', queue)
    expect(count).toBe(1)

    const [queued] = queue.dequeue(1)
    expect(queued).toMatchObject({
      type: 'bookmark',
      itemId: 'bmk_note_note_1',
      operation: 'create'
    })
    expect(JSON.parse(queued.payload)).toMatchObject({
      itemId: 'note_1',
      clock: { 'device-a': 1 }
    })

    const row = testDb.db.select().from(bookmarks).where(eq(bookmarks.id, 'bmk_note_note_1')).get()
    expect(row?.clock).toEqual({ 'device-a': 1 })
  })
})
