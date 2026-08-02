import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { TagsChannels } from '@memry/contracts/ipc-channels'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import {
  createTestDataDb,
  asClientDb,
  asSyncDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { readTagViews, writeTagViews } from '../../database/queries/tag-definitions'
import { SyncQueueManager } from '../queue'
import { tagDefinitionHandler } from './tag-definition-handler'
import type { ApplyContext, DrizzleDb } from './types'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

function makeCtx(testDb: TestDatabaseResult): ApplyContext {
  return {
    db: testDb.db as unknown as DrizzleDb,
    emit: vi.fn()
  }
}

describe('tagDefinitionHandler', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = makeCtx(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  it('inserts new remote tags with default color and emits tag refresh events', () => {
    const result = tagDefinitionHandler.applyUpsert(
      ctx,
      'focus',
      { name: 'focus', createdAt: '2026-05-01T00:00:00.000Z' },
      { 'device-b': 1 }
    )

    expect(result).toBe('applied')
    expect(
      testDb.db.select().from(tagDefinitions).where(eq(tagDefinitions.name, 'focus')).get()
    ).toMatchObject({
      name: 'focus',
      color: '#808080',
      clock: { 'device-b': 1 }
    })
    expect(ctx.emit).toHaveBeenCalledWith(TagsChannels.events.NOTES_CHANGED, { tag: 'focus' })
    expect(ctx.emit).toHaveBeenCalledWith('notes:tags-changed', {})
  })

  it('updates existing tags, skips stale clocks, and reports concurrent updates as conflicts', () => {
    testDb.db
      .insert(tagDefinitions)
      .values({
        name: 'focus',
        color: '#111111',
        clock: { 'device-a': 1 },
        createdAt: '2026-05-01T00:00:00.000Z'
      })
      .run()

    expect(
      tagDefinitionHandler.applyUpsert(
        ctx,
        'focus',
        { name: 'focus', color: '#222222' },
        { 'device-a': 2 }
      )
    ).toBe('applied')
    expect(
      testDb.db.select().from(tagDefinitions).where(eq(tagDefinitions.name, 'focus')).get()
    ).toMatchObject({ color: '#222222', clock: { 'device-a': 2 } })
    expect(ctx.emit).toHaveBeenCalledWith(TagsChannels.events.COLOR_UPDATED, {
      tag: 'focus',
      color: '#222222'
    })

    expect(
      tagDefinitionHandler.applyUpsert(
        ctx,
        'focus',
        { name: 'focus', color: '#333333' },
        { 'device-a': 1 }
      )
    ).toBe('skipped')
    expect(
      testDb.db.select().from(tagDefinitions).where(eq(tagDefinitions.name, 'focus')).get()
    ).toMatchObject({ color: '#222222' })

    expect(
      tagDefinitionHandler.applyUpsert(
        ctx,
        'focus',
        { name: 'focus', color: '#444444' },
        { 'device-b': 1 }
      )
    ).toBe('conflict')
    expect(
      testDb.db.select().from(tagDefinitions).where(eq(tagDefinitions.name, 'focus')).get()
    ).toMatchObject({
      color: '#444444',
      clock: { 'device-a': 2, 'device-b': 1 }
    })
  })

  it('builds payloads, fetches local rows, deletes by clock, and seeds unclocked tags', () => {
    testDb.db
      .insert(tagDefinitions)
      .values([
        {
          name: 'synced',
          color: '#abcdef',
          clock: { 'device-a': 1 },
          createdAt: '2026-05-01T00:00:00.000Z'
        },
        {
          name: 'local-only',
          color: '#123456',
          createdAt: '2026-05-02T00:00:00.000Z'
        }
      ])
      .run()

    expect(
      tagDefinitionHandler.fetchLocal(testDb.db as unknown as DrizzleDb, 'synced')
    ).toMatchObject({
      name: 'synced',
      color: '#abcdef'
    })
    expect(
      tagDefinitionHandler.fetchLocal(testDb.db as unknown as DrizzleDb, 'missing')
    ).toBeUndefined()

    expect(
      JSON.parse(
        tagDefinitionHandler.buildPushPayload?.(
          testDb.db as unknown as DrizzleDb,
          'synced',
          'device-a',
          'update'
        ) ?? '{}'
      )
    ).toMatchObject({
      name: 'synced',
      color: '#abcdef',
      clock: { 'device-a': 1 }
    })
    expect(
      tagDefinitionHandler.buildPushPayload?.(
        testDb.db as unknown as DrizzleDb,
        'missing',
        'device-a',
        'update'
      )
    ).toBeNull()

    expect(tagDefinitionHandler.applyDelete(ctx, 'missing')).toBe('skipped')
    expect(tagDefinitionHandler.applyDelete(ctx, 'synced', { 'device-b': 1 })).toBe('skipped')
    expect(tagDefinitionHandler.applyDelete(ctx, 'synced', { 'device-a': 2 })).toBe('applied')
    expect(
      testDb.db.select().from(tagDefinitions).where(eq(tagDefinitions.name, 'synced')).get()
    ).toBeUndefined()
    expect(ctx.emit).toHaveBeenCalledWith(TagsChannels.events.DELETED, { tag: 'synced' })

    const queue = new SyncQueueManager(asSyncDb(testDb.db))
    expect(
      tagDefinitionHandler.seedUnclocked(testDb.db as unknown as DrizzleDb, 'device-a', queue)
    ).toBe(1)
    const [queued] = queue.dequeue(1)
    expect(queued).toMatchObject({
      type: 'tag_definition',
      itemId: 'local-only',
      operation: 'create'
    })
    expect(JSON.parse(queued.payload)).toMatchObject({
      name: 'local-only',
      clock: { 'device-a': 1 }
    })
  })

  describe('category fields', () => {
    it('applies categoryId and sortOrder from a remote payload', () => {
      tagDefinitionHandler.applyUpsert(
        ctx,
        'work',
        { name: 'work', color: 'blue', categoryId: 'cat-1', sortOrder: 3 },
        { deviceA: 1 }
      )

      const row = testDb.db
        .select()
        .from(tagDefinitions)
        .where(eq(tagDefinitions.name, 'work'))
        .get()
      expect(row?.categoryId).toBe('cat-1')
      expect(row?.sortOrder).toBe(3)
    })

    it('includes the category fields in the push payload', () => {
      tagDefinitionHandler.applyUpsert(
        ctx,
        'work',
        { name: 'work', color: 'blue', categoryId: 'cat-1', sortOrder: 3 },
        { deviceA: 1 }
      )

      const json = tagDefinitionHandler.buildPushPayload(
        testDb.db as unknown as DrizzleDb,
        'work',
        'deviceA',
        'update'
      )

      expect(JSON.parse(json!)).toMatchObject({ categoryId: 'cat-1', sortOrder: 3 })
    })

    it('keeps the local category when an old-build payload omits it', () => {
      tagDefinitionHandler.applyUpsert(
        ctx,
        'work',
        { name: 'work', color: 'blue', categoryId: 'cat-1', sortOrder: 3 },
        { deviceA: 1 }
      )

      // An older client only knows name/color/icon.
      tagDefinitionHandler.applyUpsert(
        ctx,
        'work',
        { name: 'work', color: 'red' },
        { deviceA: 1, deviceB: 1 }
      )

      const row = testDb.db
        .select()
        .from(tagDefinitions)
        .where(eq(tagDefinitions.name, 'work'))
        .get()
      expect(row?.color).toBe('red')
      expect(row?.categoryId).toBe('cat-1')
      expect(row?.sortOrder).toBe(3)
    })

    it('clears categoryId when a remote payload explicitly un-assigns it, leaving sortOrder untouched', () => {
      tagDefinitionHandler.applyUpsert(
        ctx,
        'work',
        { name: 'work', color: 'blue', categoryId: 'cat-1', sortOrder: 5 },
        { deviceA: 1 }
      )

      // A dominating clock (deviceA advances) so the update branch actually runs,
      // not skipped or resolved as a concurrent merge.
      tagDefinitionHandler.applyUpsert(
        ctx,
        'work',
        { name: 'work', color: 'blue', categoryId: null },
        { deviceA: 2 }
      )

      const row = testDb.db
        .select()
        .from(tagDefinitions)
        .where(eq(tagDefinitions.name, 'work'))
        .get()
      expect(row?.categoryId).toBeNull()
      expect(row?.sortOrder).toBe(5)
    })
  })

  describe('views', () => {
    it('keeps local views when a remote payload omits the field (older client)', () => {
      tagDefinitionHandler.applyUpsert(ctx, 'work', { name: 'work', color: 'blue' }, { deviceA: 1 })
      writeTagViews(asClientDb(testDb.db), 'work', [{ name: 'Mine', type: 'table' }])

      // An older client only knows name/color — no `views` key at all.
      tagDefinitionHandler.applyUpsert(ctx, 'work', { name: 'work', color: 'red' }, { deviceA: 2 })

      expect(readTagViews(asClientDb(testDb.db), 'work')).toEqual([{ name: 'Mine', type: 'table' }])
    })

    it('clears local views when a remote payload explicitly sends null', () => {
      tagDefinitionHandler.applyUpsert(ctx, 'work', { name: 'work', color: 'blue' }, { deviceA: 1 })
      writeTagViews(asClientDb(testDb.db), 'work', [{ name: 'Mine', type: 'table' }])

      tagDefinitionHandler.applyUpsert(
        ctx,
        'work',
        { name: 'work', color: 'red', views: null },
        { deviceA: 2 }
      )

      expect(readTagViews(asClientDb(testDb.db), 'work')).toBeNull()
    })

    it('overwrites local views when a remote payload sends its own', () => {
      tagDefinitionHandler.applyUpsert(ctx, 'work', { name: 'work', color: 'blue' }, { deviceA: 1 })
      writeTagViews(asClientDb(testDb.db), 'work', [{ name: 'Mine', type: 'table' }])

      tagDefinitionHandler.applyUpsert(
        ctx,
        'work',
        { name: 'work', color: 'red', views: [{ name: 'Theirs', type: 'list' }] },
        { deviceA: 2 }
      )

      expect(readTagViews(asClientDb(testDb.db), 'work')).toEqual([
        { name: 'Theirs', type: 'list' }
      ])
    })

    it('includes saved views in the push payload', () => {
      tagDefinitionHandler.applyUpsert(ctx, 'work', { name: 'work', color: 'blue' }, { deviceA: 1 })
      writeTagViews(asClientDb(testDb.db), 'work', [{ name: 'Mine', type: 'table' }])

      const json = tagDefinitionHandler.buildPushPayload(
        testDb.db as unknown as DrizzleDb,
        'work',
        'deviceA',
        'update'
      )

      expect(JSON.parse(json!)).toMatchObject({ views: [{ name: 'Mine', type: 'table' }] })
    })
  })
})
