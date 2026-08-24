import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { TemplatesChannels } from '@memry/contracts/ipc-channels'
import { templates } from '@memry/db-schema/schema/templates'
import { createTestDataDb, asSyncDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { makeCtx } from '@tests/utils/fixtures/sync-item-handlers'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { templateHandler } from './template-handler'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

describe('templateHandler', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = makeCtx(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  it('inserts a remote template and emits CREATED', () => {
    const result = templateHandler.applyUpsert(
      ctx,
      'tpl-1',
      {
        name: 'Standup',
        icon: '✅',
        tags: ['daily'],
        properties: [],
        content: '## Blockers',
        createdAt: '2026-07-16T00:00:00.000Z'
      },
      { 'device-b': 1 }
    )

    expect(result).toBe('applied')
    expect(testDb.db.select().from(templates).where(eq(templates.id, 'tpl-1')).get()).toMatchObject(
      {
        name: 'Standup',
        icon: '✅',
        content: '## Blockers',
        clock: { 'device-b': 1 }
      }
    )
    // Payload must match the preload contract for this channel
    // ({ template }), which is also what a local create emits.
    expect(ctx.emit).toHaveBeenCalledWith(
      TemplatesChannels.events.CREATED,
      expect.objectContaining({
        template: expect.objectContaining({ id: 'tpl-1', name: 'Standup' })
      })
    )
  })

  it('skips a payload with no name instead of inventing an Untitled Template', () => {
    expect(templateHandler.applyUpsert(ctx, 'ghost', {}, { 'device-b': 1 })).toBe('skipped')
    expect(testDb.db.select().from(templates).all()).toEqual([])
    expect(ctx.emit).not.toHaveBeenCalled()
  })

  it('refuses a remote row that collides with a built-in id', () => {
    expect(templateHandler.applyUpsert(ctx, 'blank', { name: 'Impostor' }, { 'device-b': 1 })).toBe(
      'skipped'
    )
    expect(testDb.db.select().from(templates).all()).toEqual([])
  })

  it('updates on newer clock, skips stale, reports concurrent as conflict', () => {
    testDb.db
      .insert(templates)
      .values({
        id: 'tpl-1',
        name: 'Standup',
        content: 'v1',
        tags: [],
        properties: [],
        clock: { 'device-a': 1 },
        createdAt: '2026-07-16T00:00:00.000Z',
        modifiedAt: '2026-07-16T00:00:00.000Z'
      })
      .run()

    expect(templateHandler.applyUpsert(ctx, 'tpl-1', { content: 'v2' }, { 'device-a': 2 })).toBe(
      'applied'
    )
    expect(testDb.db.select().from(templates).where(eq(templates.id, 'tpl-1')).get()).toMatchObject(
      {
        content: 'v2'
      }
    )
    expect(ctx.emit).toHaveBeenCalledWith(
      TemplatesChannels.events.UPDATED,
      expect.objectContaining({
        id: 'tpl-1',
        template: expect.objectContaining({ id: 'tpl-1', content: 'v2' })
      })
    )

    expect(templateHandler.applyUpsert(ctx, 'tpl-1', { content: 'stale' }, { 'device-a': 1 })).toBe(
      'skipped'
    )
    expect(testDb.db.select().from(templates).where(eq(templates.id, 'tpl-1')).get()).toMatchObject(
      {
        content: 'v2'
      }
    )

    expect(templateHandler.applyUpsert(ctx, 'tpl-1', { content: 'v3' }, { 'device-b': 1 })).toBe(
      'conflict'
    )
    expect(testDb.db.select().from(templates).where(eq(templates.id, 'tpl-1')).get()).toMatchObject(
      {
        content: 'v3',
        clock: { 'device-a': 2, 'device-b': 1 }
      }
    )
  })

  it('builds payloads, fetches local rows, deletes by clock, and seeds unclocked templates', () => {
    testDb.db
      .insert(templates)
      .values([
        {
          id: 'synced',
          name: 'Synced',
          content: 'a',
          tags: [],
          properties: [],
          clock: { 'device-a': 1 },
          createdAt: '2026-07-16T00:00:00.000Z',
          modifiedAt: '2026-07-16T00:00:00.000Z'
        },
        {
          id: 'local-only',
          name: 'Local Only',
          content: 'b',
          tags: [],
          properties: [],
          createdAt: '2026-07-16T00:00:00.000Z',
          modifiedAt: '2026-07-16T00:00:00.000Z'
        }
      ])
      .run()

    expect(templateHandler.fetchLocal(testDb.db as unknown as DrizzleDb, 'synced')).toMatchObject({
      name: 'Synced'
    })
    expect(templateHandler.fetchLocal(testDb.db as unknown as DrizzleDb, 'missing')).toBeUndefined()

    expect(
      JSON.parse(
        templateHandler.buildPushPayload?.(
          testDb.db as unknown as DrizzleDb,
          'synced',
          'device-a',
          'update'
        ) ?? '{}'
      )
    ).toMatchObject({ name: 'Synced', clock: { 'device-a': 1 } })
    expect(
      templateHandler.buildPushPayload?.(
        testDb.db as unknown as DrizzleDb,
        'missing',
        'device-a',
        'update'
      )
    ).toBeNull()

    expect(templateHandler.applyDelete(ctx, 'missing')).toBe('skipped')
    expect(templateHandler.applyDelete(ctx, 'synced', { 'device-b': 1 })).toBe('skipped')
    expect(templateHandler.applyDelete(ctx, 'synced', { 'device-a': 2 })).toBe('applied')
    expect(ctx.emit).toHaveBeenCalledWith(TemplatesChannels.events.DELETED, { id: 'synced' })

    const queue = new SyncQueueManager(asSyncDb(testDb.db))
    expect(
      templateHandler.seedUnclocked(testDb.db as unknown as DrizzleDb, 'device-a', queue)
    ).toBe(1)
    const [queued] = queue.dequeue(1)
    expect(queued).toMatchObject({ type: 'template', itemId: 'local-only', operation: 'create' })
    expect(JSON.parse(queued.payload)).toMatchObject({ clock: { 'device-a': 1 } })
  })
})
