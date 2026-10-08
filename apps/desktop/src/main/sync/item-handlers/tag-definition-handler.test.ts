import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { TagsChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import {
  TagDefinitionSyncPayloadSchema,
  type TagDefinitionSyncPayload
} from '@memry/contracts/sync-payloads'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import {
  createTestDataDb,
  asClientDb,
  asSyncDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { readTagViews, writeTagViews } from '../../database/queries/tag-definitions'
import { SyncQueueManager } from '@memry/sync-client/queue'
import {
  initTagDefinitionSyncService,
  resetTagDefinitionSyncService
} from '@memry/sync-client/tag-definition-sync'
import { tagDefinitionHandler } from './tag-definition-handler'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

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
      // No colour, which the handler defaults.
      { name: 'focus', createdAt: '2026-05-01T00:00:00.000Z' } as TagDefinitionSyncPayload,
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
    // Local happened after the tombstone: the delete loses.
    expect(tagDefinitionHandler.applyDelete(ctx, 'synced', { 'device-a': 0 })).toBe('skipped')
    // Concurrent with the local row: delete still wins (#2198).
    expect(tagDefinitionHandler.applyDelete(ctx, 'synced', { 'device-b': 1 })).toBe('applied')
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

// Chapter 06 §6.11: the schema joins by its own `t` on every branch, and a
// device that holds more than the remote re-pushes it under a ticked clock.
describe('tagDefinitionHandler versioned schema', () => {
  const V2 = { t: 2, fields: [{ name: 'Role' }], preset: 'person' }
  const V3 = { t: 3, fields: [{ name: 'Role' }, { name: 'Email' }], preset: 'person' }

  let testDb: TestDatabaseResult
  let ctx: ApplyContext
  let queue: SyncQueueManager

  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = makeCtx(testDb)
    queue = new SyncQueueManager(asSyncDb(testDb.db))
    initTagDefinitionSyncService({
      queue,
      db: asSyncDb(testDb.db),
      getDeviceId: () => 'device-a'
    })
  })

  afterEach(() => {
    resetTagDefinitionSyncService()
    testDb.close()
  })

  function seed(schema: object | null, clock: VectorClock): void {
    testDb.db
      .insert(tagDefinitions)
      .values({
        name: 'person',
        color: '#111111',
        clock,
        schema: schema === null ? null : JSON.stringify(schema)
      })
      .run()
  }

  function row(): { schema: unknown; clock: unknown } {
    const stored = testDb.db
      .select()
      .from(tagDefinitions)
      .where(eq(tagDefinitions.name, 'person'))
      .get()
    return {
      schema: stored?.schema ? (JSON.parse(stored.schema) as unknown) : null,
      clock: stored?.clock
    }
  }

  function pushed(): Record<string, unknown> {
    const payload = tagDefinitionHandler.buildPushPayload(
      testDb.db as unknown as DrizzleDb,
      'person',
      'device-a',
      'update'
    )
    return JSON.parse(payload!) as Record<string, unknown>
  }

  it('keeps the schema an older peer stripped and re-pushes it past the replay check', () => {
    seed(V3, { 'device-a': 1 })

    const result = tagDefinitionHandler.applyUpsert(
      ctx,
      'person',
      { name: 'person', color: '#222222' },
      { 'device-a': 1, 'device-b': 1 }
    )

    expect(result).toBe('applied')
    expect(row()).toEqual({ schema: V3, clock: { 'device-a': 2, 'device-b': 1 } })
    expect(queue.dequeue(10)).toMatchObject([
      { type: 'tag_definition', itemId: 'person', operation: 'update' }
    ])
    expect(pushed()).toMatchObject({ schema: V3, clock: { 'device-a': 2, 'device-b': 1 } })
  })

  it('rejects a stale schema echoed under a newer clock (#2265 capture) and heals', () => {
    seed(V3, { 'device-a': 1 })

    tagDefinitionHandler.applyUpsert(
      ctx,
      'person',
      { name: 'person', color: '#111111', schema: V2 },
      { 'device-a': 1, 'device-b': 1 }
    )

    expect(row().schema).toEqual(V3)
    expect(queue.dequeue(10)).toHaveLength(1)
  })

  it('takes a newer schema without re-pushing it', () => {
    seed(V2, { 'device-a': 1 })

    tagDefinitionHandler.applyUpsert(
      ctx,
      'person',
      { name: 'person', color: '#111111', schema: V3 },
      { 'device-a': 1, 'device-b': 1 }
    )

    expect(row()).toEqual({ schema: V3, clock: { 'device-a': 1, 'device-b': 1 } })
    expect(queue.dequeue(10)).toEqual([])
  })

  it('reads a null schema as no information: nothing written, nothing re-pushed', () => {
    seed(V3, { 'device-a': 1 })

    tagDefinitionHandler.applyUpsert(
      ctx,
      'person',
      { name: 'person', color: '#111111', schema: null },
      { 'device-a': 1, 'device-b': 1 }
    )

    expect(row().schema).toEqual(V3)
    expect(queue.dequeue(10)).toEqual([])
  })

  it('applies and re-pushes nothing for its own echo', () => {
    seed(V3, { 'device-a': 2 })
    const echo = TagDefinitionSyncPayloadSchema.parse(pushed())

    const result = tagDefinitionHandler.applyUpsert(ctx, 'person', echo, { 'device-a': 2 })

    expect(result).toBe('skipped')
    expect(row()).toEqual({ schema: V3, clock: { 'device-a': 2 } })
    expect(queue.dequeue(10)).toEqual([])
  })

  it('re-pushes nothing when another device sends the same schema under a newer clock', () => {
    seed(V3, { 'device-a': 1 })

    tagDefinitionHandler.applyUpsert(
      ctx,
      'person',
      { name: 'person', color: '#333333', schema: structuredClone(V3) },
      { 'device-a': 1, 'device-b': 1 }
    )

    expect(row().schema).toEqual(V3)
    expect(queue.dequeue(10)).toEqual([])
  })

  it('joins a newer schema carried by a payload the clock skips, without a re-push', () => {
    seed(V2, { 'device-a': 3 })

    const result = tagDefinitionHandler.applyUpsert(
      ctx,
      'person',
      { name: 'person', color: '#999999', schema: V3 },
      { 'device-a': 1 }
    )

    expect(result).toBe('skipped')
    expect(row()).toEqual({ schema: V3, clock: { 'device-a': 3 } })
    expect(queue.dequeue(10)).toEqual([])
  })

  it('takes the remote schema when it inserts the tag', () => {
    tagDefinitionHandler.applyUpsert(
      ctx,
      'person',
      { name: 'person', color: '#111111', schema: V2 },
      { 'device-b': 1 }
    )

    expect(row()).toEqual({ schema: V2, clock: { 'device-b': 1 } })
    expect(queue.dequeue(10)).toEqual([])
  })

  it('leaves a concurrent edit to the conflict re-queue instead of enqueueing a heal', () => {
    seed(V3, { 'device-a': 2 })

    const result = tagDefinitionHandler.applyUpsert(
      ctx,
      'person',
      { name: 'person', color: '#222222' },
      { 'device-b': 1 }
    )

    expect(result).toBe('conflict')
    expect(row()).toEqual({ schema: V3, clock: { 'device-a': 2, 'device-b': 1 } })
    expect(queue.dequeue(10)).toEqual([])
  })

  it('leaves out a NULL schema and NULL views, and sends [] views and a stored schema', () => {
    seed(null, { 'device-a': 1 })
    expect(pushed()).not.toHaveProperty('schema')
    expect(pushed()).not.toHaveProperty('views')

    writeTagViews(asClientDb(testDb.db), 'person', [])
    testDb.db
      .update(tagDefinitions)
      .set({ schema: JSON.stringify(V2) })
      .where(eq(tagDefinitions.name, 'person'))
      .run()
    expect(pushed()).toMatchObject({ views: [], schema: V2 })

    testDb.db
      .update(tagDefinitions)
      .set({ schema: '{not json' })
      .where(eq(tagDefinitions.name, 'person'))
      .run()
    expect(pushed()).not.toHaveProperty('schema')
  })
})
