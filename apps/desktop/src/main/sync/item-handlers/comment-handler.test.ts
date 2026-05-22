import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { comments } from '@memry/db-schema/schema/comments'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { makeCtx } from '@tests/utils/fixtures/sync-item-handlers'
import { commentHandler } from './comment-handler'
import type { ApplyContext } from './types'

const mentionRefs = [
  { kind: 'note', refId: 'note-1', label: 'Launch notes' },
  { kind: 'calendar_event', refId: 'event-1', label: 'Planning sync' }
] as const

describe('commentHandler mentionRefs', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = makeCtx(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  it('applies and pushes mentionRefs with the comment payload', () => {
    const result = commentHandler.applyUpsert(
      ctx,
      'comment-1',
      {
        targetType: 'note',
        targetId: 'note-1',
        selectedQuote: 'selected text',
        blockId: null,
        rangeStart: 0,
        rangeEnd: 13,
        prefix: null,
        suffix: null,
        body: 'See @Launch notes',
        mentionRefs,
        attachmentRefs: ['memry://attachment/image.png'],
        status: 'open',
        clock: { 'device-a': 1 },
        syncedAt: null,
        createdAt: '2026-05-22T00:00:00.000Z',
        modifiedAt: '2026-05-22T00:00:00.000Z'
      },
      { 'device-a': 1 }
    )

    expect(result).toBe('applied')

    const row = testDb.db.select().from(comments).where(eq(comments.id, 'comment-1')).get()
    expect(row?.mentionRefs).toEqual(mentionRefs)

    const pushed = commentHandler.buildPushPayload(ctx.db, 'comment-1')
    expect(JSON.parse(pushed ?? '{}')).toMatchObject({ mentionRefs })
  })
})
