import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { createTestDataDb, asSyncDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { calendarBindingHandler } from '@memry/sync-client/item-handlers/calendar-binding-handler'
import { calendarSourceHandler } from '@memry/sync-client/item-handlers/calendar-source-handler'
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

describe('calendarSourceHandler', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = makeCtx(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  it('inserts defaults, updates partial remote fields, and serializes payloads', () => {
    expect(calendarSourceHandler.applyUpsert(ctx, 'source-1', {}, { 'device-b': 1 })).toBe(
      'applied'
    )
    expect(
      testDb.db.select().from(calendarSources).where(eq(calendarSources.id, 'source-1')).get()
    ).toMatchObject({
      provider: 'google',
      kind: 'calendar',
      remoteId: 'source-1',
      title: 'Untitled calendar',
      isSelected: false,
      clock: { 'device-b': 1 }
    })

    expect(
      calendarSourceHandler.applyUpsert(
        ctx,
        'source-1',
        {
          title: 'Work',
          color: '#ff0000',
          isPrimary: true,
          isSelected: true,
          syncStatus: 'ok',
          syncCursor: 'cursor-1',
          metadata: { pageToken: 'next' },
          lastSyncedAt: '2026-05-01T01:00:00.000Z',
          modifiedAt: '2026-05-01T02:00:00.000Z'
        },
        { 'device-b': 2 }
      )
    ).toBe('applied')

    const row = testDb.db
      .select()
      .from(calendarSources)
      .where(eq(calendarSources.id, 'source-1'))
      .get()
    expect(row).toMatchObject({
      title: 'Work',
      color: '#ff0000',
      isPrimary: true,
      isSelected: true,
      syncStatus: 'ok',
      syncCursor: 'cursor-1',
      metadata: { pageToken: 'next' },
      clock: { 'device-b': 2 }
    })
    expect(ctx.emit).toHaveBeenCalledWith('calendar:changed', {
      entityType: 'calendar_source',
      id: 'source-1'
    })

    expect(
      JSON.parse(
        calendarSourceHandler.buildPushPayload(testDb.db as unknown as DrizzleDb, 'source-1') ??
          '{}'
      )
    ).toMatchObject({
      title: 'Work',
      color: '#ff0000',
      metadata: { pageToken: 'next' },
      clock: { 'device-b': 2 }
    })
    expect(
      calendarSourceHandler.buildPushPayload(testDb.db as unknown as DrizzleDb, 'missing')
    ).toBeNull()
  })

  it('handles skip/conflict delete paths and seeds unclocked sources', () => {
    testDb.db
      .insert(calendarSources)
      .values([
        {
          id: 'source-synced',
          provider: 'google',
          kind: 'calendar',
          remoteId: 'remote-synced',
          title: 'Synced',
          clock: { 'device-a': 2 }
        },
        {
          id: 'source-local',
          provider: 'google',
          kind: 'calendar',
          remoteId: 'remote-local',
          title: 'Local'
        }
      ])
      .run()

    expect(
      calendarSourceHandler.applyUpsert(
        ctx,
        'source-synced',
        { title: 'Stale remote' },
        { 'device-a': 1 }
      )
    ).toBe('skipped')
    expect(
      calendarSourceHandler.applyUpsert(
        ctx,
        'source-synced',
        { title: 'Concurrent remote' },
        { 'device-b': 1 }
      )
    ).toBe('conflict')

    expect(
      calendarSourceHandler.fetchLocal(testDb.db as unknown as DrizzleDb, 'source-synced')
    ).toMatchObject({
      title: 'Concurrent remote'
    })
    expect(
      calendarSourceHandler.fetchLocal(testDb.db as unknown as DrizzleDb, 'missing')
    ).toBeUndefined()

    expect(calendarSourceHandler.applyDelete(ctx, 'missing')).toBe('skipped')
    expect(calendarSourceHandler.applyDelete(ctx, 'source-synced', { 'device-c': 1 })).toBe(
      'skipped'
    )
    expect(
      calendarSourceHandler.applyDelete(ctx, 'source-synced', {
        'device-a': 2,
        'device-b': 1,
        'device-c': 1
      })
    ).toBe('applied')

    const queue = new SyncQueueManager(asSyncDb(testDb.db))
    expect(
      calendarSourceHandler.seedUnclocked(testDb.db as unknown as DrizzleDb, 'device-a', queue)
    ).toBe(1)
    const [queued] = queue.dequeue(1)
    expect(queued).toMatchObject({
      type: 'calendar_source',
      itemId: 'source-local',
      operation: 'create'
    })
    expect(JSON.parse(queued.payload)).toMatchObject({
      id: 'source-local',
      clock: { 'device-a': 1 }
    })
  })
})

describe('calendarBindingHandler', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = makeCtx(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  it('inserts defaults, updates provider fields, and serializes payloads', () => {
    expect(calendarBindingHandler.applyUpsert(ctx, 'binding-1', {}, { 'device-b': 1 })).toBe(
      'applied'
    )
    expect(
      testDb.db.select().from(calendarBindings).where(eq(calendarBindings.id, 'binding-1')).get()
    ).toMatchObject({
      sourceType: 'event',
      sourceId: 'binding-1',
      provider: 'google',
      remoteCalendarId: 'primary',
      remoteEventId: 'binding-1',
      ownershipMode: 'memry_managed',
      writebackMode: 'broad',
      clock: { 'device-b': 1 }
    })

    expect(
      calendarBindingHandler.applyUpsert(
        ctx,
        'binding-1',
        {
          sourceType: 'task',
          sourceId: 'task-1',
          remoteCalendarId: 'calendar-1',
          remoteEventId: 'event-1',
          ownershipMode: 'provider_managed',
          writebackMode: 'schedule_only',
          remoteVersion: 'etag-1',
          lastLocalSnapshot: { title: 'Task' },
          archivedAt: '2026-05-01T00:00:00.000Z',
          modifiedAt: '2026-05-01T02:00:00.000Z'
        },
        { 'device-b': 2 }
      )
    ).toBe('applied')

    const row = testDb.db
      .select()
      .from(calendarBindings)
      .where(eq(calendarBindings.id, 'binding-1'))
      .get()
    expect(row).toMatchObject({
      sourceType: 'task',
      sourceId: 'task-1',
      remoteCalendarId: 'calendar-1',
      remoteEventId: 'event-1',
      ownershipMode: 'provider_managed',
      writebackMode: 'schedule_only',
      remoteVersion: 'etag-1',
      lastLocalSnapshot: { title: 'Task' },
      clock: { 'device-b': 2 }
    })

    expect(
      JSON.parse(
        calendarBindingHandler.buildPushPayload(testDb.db as unknown as DrizzleDb, 'binding-1') ??
          '{}'
      )
    ).toMatchObject({
      sourceType: 'task',
      sourceId: 'task-1',
      remoteCalendarId: 'calendar-1',
      remoteVersion: 'etag-1',
      clock: { 'device-b': 2 }
    })
    expect(
      calendarBindingHandler.buildPushPayload(testDb.db as unknown as DrizzleDb, 'missing')
    ).toBeNull()
  })

  it('handles stale/concurrent clocks, deletes applied rows, and seeds unclocked bindings', () => {
    testDb.db
      .insert(calendarBindings)
      .values([
        {
          id: 'binding-synced',
          sourceType: 'task',
          sourceId: 'task-synced',
          provider: 'google',
          remoteCalendarId: 'calendar-synced',
          remoteEventId: 'event-synced',
          ownershipMode: 'memry_managed',
          writebackMode: 'broad',
          clock: { 'device-a': 2 }
        },
        {
          id: 'binding-local',
          sourceType: 'event',
          sourceId: 'event-local',
          provider: 'google',
          remoteCalendarId: 'calendar-local',
          remoteEventId: 'event-local',
          ownershipMode: 'memry_managed',
          writebackMode: 'broad'
        }
      ])
      .run()

    expect(
      calendarBindingHandler.applyUpsert(
        ctx,
        'binding-synced',
        { remoteVersion: 'stale' },
        { 'device-a': 1 }
      )
    ).toBe('skipped')
    expect(
      calendarBindingHandler.applyUpsert(
        ctx,
        'binding-synced',
        { remoteVersion: 'etag-concurrent' },
        { 'device-b': 1 }
      )
    ).toBe('conflict')

    expect(
      calendarBindingHandler.fetchLocal(testDb.db as unknown as DrizzleDb, 'binding-synced')
    ).toMatchObject({
      remoteVersion: 'etag-concurrent'
    })
    expect(
      calendarBindingHandler.fetchLocal(testDb.db as unknown as DrizzleDb, 'missing')
    ).toBeUndefined()

    expect(calendarBindingHandler.applyDelete(ctx, 'missing')).toBe('skipped')
    expect(calendarBindingHandler.applyDelete(ctx, 'binding-synced', { 'device-c': 1 })).toBe(
      'skipped'
    )
    expect(
      calendarBindingHandler.applyDelete(ctx, 'binding-synced', {
        'device-a': 2,
        'device-b': 1,
        'device-c': 1
      })
    ).toBe('applied')

    const queue = new SyncQueueManager(asSyncDb(testDb.db))
    expect(
      calendarBindingHandler.seedUnclocked(testDb.db as unknown as DrizzleDb, 'device-a', queue)
    ).toBe(1)
    const [queued] = queue.dequeue(1)
    expect(queued).toMatchObject({
      type: 'calendar_binding',
      itemId: 'binding-local',
      operation: 'create'
    })
    expect(JSON.parse(queued.payload)).toMatchObject({
      id: 'binding-local',
      clock: { 'device-a': 1 }
    })
  })
})
