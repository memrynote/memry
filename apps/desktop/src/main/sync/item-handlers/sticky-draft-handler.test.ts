import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { stickyDrafts } from '@memry/db-schema/schema/sticky-drafts'
import { StickyChannels } from '@memry/contracts/ipc-channels'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

const mocks = vi.hoisted(() => ({ notifyStickyDraftsChanged: vi.fn() }))

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('../../stickies/drafts-changed', () => ({
  notifyStickyDraftsChanged: mocks.notifyStickyDraftsChanged
}))

import { stickyDraftHandler } from './sticky-draft-handler'

describe('stickyDraftHandler', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  const row = () =>
    testDb.db.select().from(stickyDrafts).where(eq(stickyDrafts.id, 'draft-1')).get()

  beforeEach(() => {
    vi.clearAllMocks()
    testDb = createTestDataDb()
    ctx = { db: testDb.db as unknown as DrizzleDb, emit: vi.fn() }
  })

  afterEach(() => {
    testDb.close()
  })

  it('applies a draft typed on another device and tells windows and the edge tab', () => {
    const result = stickyDraftHandler.applyUpsert(
      ctx,
      'draft-1',
      { content: 'Book the dentist', kind: 'task' },
      { 'device-b': 1 }
    )

    expect(result).toBe('applied')
    expect(row()).toMatchObject({ content: 'Book the dentist', kind: 'task' })
    expect(ctx.emit).toHaveBeenCalledWith(StickyChannels.events.DRAFTS_CHANGED, {})
    expect(mocks.notifyStickyDraftsChanged).toHaveBeenCalled()
  })

  it('keeps the later edit and ignores an older one', () => {
    stickyDraftHandler.applyUpsert(ctx, 'draft-1', { content: 'v2', kind: 'note' }, { b: 2 })

    const result = stickyDraftHandler.applyUpsert(ctx, 'draft-1', { content: 'v1' }, { b: 1 })

    expect(result).toBe('skipped')
    expect(row()?.content).toBe('v2')
  })

  it('keeps a kind from a newer build as text instead of dropping the draft', () => {
    stickyDraftHandler.applyUpsert(ctx, 'draft-1', { content: 'x', kind: 'canvas' }, { b: 1 })

    expect(row()?.kind).toBe('canvas')
  })

  it('does not create an empty ghost draft from a payload with no content', () => {
    const result = stickyDraftHandler.applyUpsert(ctx, 'draft-1', {}, { b: 1 })

    expect(result).toBe('skipped')
    expect(row()).toBeUndefined()
    expect(ctx.emit).not.toHaveBeenCalled()
  })

  it('removes a draft another device sent, unless this device edited it since', () => {
    stickyDraftHandler.applyUpsert(ctx, 'draft-1', { content: 'x', kind: 'note' }, { b: 1 })
    testDb.db
      .update(stickyDrafts)
      .set({ clock: { a: 1, b: 1 } })
      .where(eq(stickyDrafts.id, 'draft-1'))
      .run()

    expect(stickyDraftHandler.applyDelete(ctx, 'draft-1', { b: 1 })).toBe('skipped')
    expect(row()).toBeDefined()

    expect(stickyDraftHandler.applyDelete(ctx, 'draft-1', { a: 1, b: 2 })).toBe('applied')
    expect(row()).toBeUndefined()
  })
})
