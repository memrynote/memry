import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TestDatabaseResult, TestDb } from '@tests/utils/test-db'
import { createTestIndexDb } from '@tests/utils/test-db'
import { insertNoteCache } from './note-crud'
import { getJournalPropertyRows } from './journal-queries'
import { setNoteProperties } from './property-queries'
import { inferPropertyType } from './query-helpers'

describe('getJournalPropertyRows', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  const insertNote = (id: string, date: string | null, props: Record<string, unknown>): void => {
    insertNoteCache(db, {
      id,
      path: date ? `journal/${date}.md` : `notes/${id}.md`,
      title: date ?? id,
      contentHash: `hash-${id}`,
      wordCount: 0,
      characterCount: 0,
      date,
      createdAt: '2026-09-01T00:00:00.000Z',
      modifiedAt: '2026-09-01T00:00:00.000Z'
    })
    setNoteProperties(db, id, props, (_name, value) => inferPropertyType(value))
  }

  beforeEach(() => {
    dbResult = createTestIndexDb()
    db = dbResult.db
  })

  afterEach(() => {
    dbResult.close()
  })

  it('returns entries in range oldest first, with their values', () => {
    insertNote('j3', '2026-09-03', { sleep: 6.5, workout: false })
    insertNote('j1', '2026-09-01', { sleep: 7.5, workout: true })
    insertNote('j9', '2026-09-09', { sleep: 8 })
    insertNote('n1', null, { sleep: 4 })

    const { rows } = getJournalPropertyRows(db, '2026-09-01', '2026-09-05')

    expect(rows.map((row) => [row.date, row.properties])).toEqual([
      ['2026-09-01', { sleep: 7.5, workout: true }],
      ['2026-09-03', { sleep: 6.5, workout: false }]
    ])
  })

  it('lists journal properties by use, ignoring regular notes', () => {
    insertNote('j1', '2026-09-01', { sleep: 7, mood: 'good' })
    insertNote('j2', '2026-09-02', { sleep: 6 })
    insertNote('n1', null, { priority: 'high' })

    const { properties } = getJournalPropertyRows(db, '2026-09-01', '2026-09-02')

    expect(properties).toEqual([
      { name: 'sleep', type: 'number', count: 2 },
      { name: 'mood', type: 'text', count: 1 }
    ])
  })
})
