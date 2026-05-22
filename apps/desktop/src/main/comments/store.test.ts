import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { asClientDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { createComment, listComments, updateComment } from './store'

const mentionRefs = [
  { kind: 'note', refId: 'note-1', label: 'Launch notes' },
  { kind: 'task', refId: 'task-1', label: 'Ship inline comments' }
] as const

describe('comment store mentionRefs', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDataDb()
  })

  afterEach(() => {
    testDb.close()
  })

  it('preserves mentionRefs through create, list, and update', () => {
    const db = asClientDb(testDb.db)

    const created = createComment(
      {
        targetType: 'note',
        targetId: 'note-1',
        selectedQuote: 'selected text',
        body: 'See @Launch notes',
        mentionRefs,
        attachmentRefs: ['memry://attachment/image.png']
      },
      db
    )

    expect(created.mentionRefs).toEqual(mentionRefs)

    const [listed] = listComments({ targetType: 'note', targetId: 'note-1' }, db)
    expect(listed.mentionRefs).toEqual(mentionRefs)

    const updated = updateComment(
      {
        id: created.id,
        mentionRefs: [{ kind: 'calendar_event', refId: 'event-1', label: 'Planning sync' }]
      },
      db
    )

    expect(updated.mentionRefs).toEqual([
      { kind: 'calendar_event', refId: 'event-1', label: 'Planning sync' }
    ])
  })
})
