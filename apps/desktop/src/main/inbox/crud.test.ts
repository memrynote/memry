import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { InboxItem } from '@memry/contracts/inbox-api'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import { inboxItems, inboxItemTags } from '@memry/db-schema/schema/inbox'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { DataDb } from '../database'
import { createInboxCrudHandlers, type InboxCrudHandlerDeps } from './crud'

const mocks = vi.hoisted(() => ({
  deleteInboxAttachments: vi.fn(),
  syncInboxDelete: vi.fn()
}))

vi.mock('./attachments', () => ({
  deleteInboxAttachments: (...args: unknown[]) => mocks.deleteInboxAttachments(...args)
}))

vi.mock('./runtime-effects', () => ({
  syncInboxDelete: (...args: unknown[]) => mocks.syncInboxDelete(...args)
}))

function makeInboxItem(overrides: Partial<typeof inboxItems.$inferInsert> = {}) {
  return {
    id: 'item-1',
    type: 'note',
    title: 'Original',
    content: 'Body',
    createdAt: '2026-05-01T00:00:00.000Z',
    modifiedAt: '2026-05-01T00:00:00.000Z',
    ...overrides
  }
}

function readTags(db: DataDb, itemId: string): string[] {
  return db
    .select()
    .from(inboxItemTags)
    .where(eq(inboxItemTags.itemId, itemId))
    .all()
    .map((row) => row.tag)
}

function toInboxItem(row: typeof inboxItems.$inferSelect, tags: string[]): InboxItem {
  return {
    id: row.id,
    type: row.type as InboxItem['type'],
    title: row.title,
    content: row.content ?? undefined,
    tags,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt,
    filedAt: row.filedAt ?? undefined,
    filedTo: row.filedTo ?? undefined,
    filedAction: row.filedAction as InboxItem['filedAction'],
    archivedAt: row.archivedAt ?? undefined,
    viewedAt: row.viewedAt ?? undefined
  } as InboxItem
}

describe('createInboxCrudHandlers', () => {
  let testDb: TestDatabaseResult
  let deps: InboxCrudHandlerDeps

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T12:00:00.000Z'))
    vi.clearAllMocks()
    mocks.deleteInboxAttachments.mockResolvedValue(undefined)

    testDb = createTestDataDb()
    deps = {
      requireDatabase: () => testDb.db as unknown as DataDb,
      getItemTags: readTags,
      toInboxItem,
      emitInboxEvent: vi.fn(),
      syncInboxUpdate: vi.fn(),
      logger: {
        info: vi.fn(),
        error: vi.fn()
      }
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    testDb.close()
  })

  it('gets, updates, archives, and marks inbox items viewed', async () => {
    testDb.db.insert(inboxItems).values(makeInboxItem()).run()
    testDb.db
      .insert(inboxItemTags)
      .values({
        id: 'tag-1',
        itemId: 'item-1',
        tag: 'inbox',
        createdAt: '2026-05-01T00:00:00.000Z'
      })
      .run()

    const handlers = createInboxCrudHandlers(deps)

    await expect(handlers.handleGet('missing')).resolves.toBeNull()
    await expect(handlers.handleGet('item-1')).resolves.toMatchObject({
      id: 'item-1',
      title: 'Original',
      tags: ['inbox']
    })

    await expect(
      handlers.handleUpdate({ id: 'item-1', title: 'Updated', content: 'New body' })
    ).resolves.toMatchObject({
      success: true,
      item: { title: 'Updated', content: 'New body' }
    })
    expect(deps.emitInboxEvent).toHaveBeenCalledWith(InboxChannels.events.UPDATED, {
      id: 'item-1',
      changes: {
        title: 'Updated',
        content: 'New body',
        modifiedAt: '2026-05-10T12:00:00.000Z'
      }
    })
    expect(deps.syncInboxUpdate).toHaveBeenCalledWith('item-1')

    await expect(handlers.handleUpdate({ id: 'missing', title: 'Nope' })).resolves.toMatchObject({
      success: false,
      error: 'Item not found'
    })
    await expect(handlers.handleUpdate({ id: 'item-1', title: '' })).resolves.toMatchObject({
      success: false
    })

    await expect(handlers.handleArchive('item-1')).resolves.toEqual({ success: true })
    expect(deps.emitInboxEvent).toHaveBeenCalledWith(InboxChannels.events.ARCHIVED, {
      id: 'item-1'
    })

    await expect(handlers.handleMarkViewed('')).resolves.toEqual({
      success: false,
      error: 'itemId is required'
    })
    await expect(handlers.handleMarkViewed('item-1')).resolves.toEqual({ success: true })
    expect(deps.logger.info).toHaveBeenCalledWith('Marked item item-1 as viewed')

    expect(
      testDb.db.select().from(inboxItems).where(eq(inboxItems.id, 'item-1')).get()
    ).toMatchObject({
      title: 'Updated',
      archivedAt: '2026-05-10T12:00:00.000Z',
      viewedAt: '2026-05-10T12:00:00.000Z'
    })
  })

  it('adds and removes tags idempotently', async () => {
    testDb.db.insert(inboxItems).values(makeInboxItem()).run()
    const handlers = createInboxCrudHandlers(deps)

    await expect(handlers.handleAddTag('missing', 'later')).resolves.toEqual({
      success: false,
      error: 'Item not found'
    })

    await expect(handlers.handleAddTag('item-1', 'later')).resolves.toEqual({ success: true })
    await expect(handlers.handleAddTag('item-1', 'later')).resolves.toEqual({ success: true })
    expect(readTags(testDb.db as unknown as DataDb, 'item-1')).toEqual(['later'])

    await expect(handlers.handleRemoveTag('item-1', 'later')).resolves.toEqual({ success: true })
    expect(readTags(testDb.db as unknown as DataDb, 'item-1')).toEqual([])
  })

  it('unarchives, undoes filing, permanently deletes, and reports missing-state errors', async () => {
    testDb.db
      .insert(inboxItems)
      .values([
        makeInboxItem({
          id: 'archived',
          archivedAt: '2026-05-09T00:00:00.000Z'
        }),
        makeInboxItem({
          id: 'filed',
          filedAt: '2026-05-09T00:00:00.000Z',
          filedTo: 'notes/one.md',
          filedAction: 'note'
        }),
        makeInboxItem({ id: 'plain' })
      ])
      .run()
    testDb.db
      .insert(inboxItemTags)
      .values({ id: 'tag-delete', itemId: 'plain', tag: 'delete-me' })
      .run()

    const handlers = createInboxCrudHandlers(deps)

    await expect(handlers.handleUnarchive('missing')).resolves.toEqual({
      success: false,
      error: 'Item not found'
    })
    await expect(handlers.handleUnarchive('plain')).resolves.toEqual({
      success: false,
      error: 'Item is not archived'
    })
    await expect(handlers.handleUnarchive('archived')).resolves.toEqual({ success: true })

    await expect(handlers.handleUndoFile('missing')).resolves.toEqual({
      success: false,
      error: 'Item not found'
    })
    await expect(handlers.handleUndoFile('plain')).resolves.toEqual({
      success: false,
      error: 'Item is not filed'
    })
    await expect(handlers.handleUndoFile('filed')).resolves.toEqual({ success: true })
    expect(deps.logger.info).toHaveBeenCalledWith('Undo file for item filed')

    await expect(handlers.handleUndoArchive('missing')).resolves.toEqual({
      success: false,
      error: 'Item not found'
    })
    await expect(handlers.handleUndoArchive('plain')).resolves.toEqual({
      success: false,
      error: 'Item is not archived'
    })

    await expect(handlers.handleDeletePermanent('missing')).resolves.toEqual({
      success: false,
      error: 'Item not found'
    })
    await expect(handlers.handleDeletePermanent('plain')).resolves.toEqual({ success: true })

    expect(mocks.deleteInboxAttachments).toHaveBeenCalledWith('plain')
    expect(mocks.syncInboxDelete).toHaveBeenCalledWith('plain', expect.stringContaining('"plain"'))
    expect(
      testDb.db.select().from(inboxItems).where(eq(inboxItems.id, 'plain')).get()
    ).toBeUndefined()
    expect(readTags(testDb.db as unknown as DataDb, 'plain')).toEqual([])
  })

  it('returns caught database errors without throwing', async () => {
    const handlers = createInboxCrudHandlers({
      ...deps,
      requireDatabase: () => {
        throw new Error('db unavailable')
      }
    })

    await expect(handlers.handleArchive('item-1')).resolves.toEqual({
      success: false,
      error: 'db unavailable'
    })
    await expect(handlers.handleRemoveTag('item-1', 'tag')).resolves.toEqual({
      success: false,
      error: 'db unavailable'
    })
  })
})
