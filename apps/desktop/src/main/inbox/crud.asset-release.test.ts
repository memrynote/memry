/**
 * Permanent delete of an inbox item whose file synced (#4157): the delete is
 * recorded so the blob is freed on the server after the grace period, on a
 * real data DB.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deletedAssetReleases } from '@memry/db-schema/schema/deleted-asset-releases'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { createTestDataDb, type TestDataDb } from '../../test/helpers/test-data-db'
import { createInboxCrudHandlers } from './crud'

vi.mock('./attachments', () => ({ deleteInboxAttachments: vi.fn() }))
vi.mock('./runtime-effects', () => ({ syncInboxDelete: vi.fn() }))

let db: TestDataDb

const handlers = () =>
  createInboxCrudHandlers({
    requireDatabase: () => db,
    getItemTags: () => [],
    toInboxItem: vi.fn(),
    emitInboxEvent: vi.fn(),
    syncInboxUpdate: vi.fn(),
    logger: { info: vi.fn(), error: vi.fn() }
  })

const releases = () =>
  db
    .select()
    .from(deletedAssetReleases)
    .all()
    .map((row) => ({ type: row.itemType, id: row.itemId, attachmentIds: row.attachmentIds }))

beforeEach(() => {
  db = createTestDataDb()
})

describe('handleDeletePermanent and the 30-day release', () => {
  it('records an unfiled item so its blob is freed after the grace period', async () => {
    db.insert(inboxItems)
      .values({ id: 'photo', type: 'image', title: 'Photo', attachmentId: 'att-1' })
      .run()

    await expect(handlers().handleDeletePermanent('photo')).resolves.toEqual({ success: true })

    expect(releases()).toEqual([{ type: 'inbox', id: 'photo', attachmentIds: ['att-1'] }])
  })

  it('records nothing for a filed item, whose blob belongs to the note', async () => {
    db.insert(inboxItems)
      .values({
        id: 'filed',
        type: 'image',
        title: 'Filed',
        attachmentId: 'att-1',
        filedAt: '2026-05-02T00:00:00.000Z'
      })
      .run()

    await handlers().handleDeletePermanent('filed')

    expect(releases()).toEqual([])
  })

  it('records nothing for an item whose file never synced', async () => {
    db.insert(inboxItems).values({ id: 'local', type: 'image', title: 'Local' }).run()

    await handlers().handleDeletePermanent('local')

    expect(releases()).toEqual([])
  })
})
