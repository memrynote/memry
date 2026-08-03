import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TestDatabaseResult, TestDb } from '@tests/utils/test-db'
import { createTestIndexDb } from '@tests/utils/test-db'
import { insertNoteCache } from './note-crud'
import { setNoteProperties } from './property-queries'
import { inferPropertyType } from '../../../vault/frontmatter'
import {
  setPropertyRefs,
  getPropertyRefsForNote,
  getIncomingPropertyRefs
} from './property-ref-queries'

describe('property refs', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  const insertTestNote = (database: TestDb, id: string): void => {
    insertNoteCache(database, {
      id,
      path: `notes/${id}.md`,
      title: id,
      contentHash: `hash-${id}`,
      wordCount: 0,
      characterCount: 0,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z'
    })
  }

  beforeEach(() => {
    dbResult = createTestIndexDb()
    db = dbResult.db
  })

  afterEach(() => {
    dbResult.close()
  })

  it('writes one row per parsed URI', () => {
    insertTestNote(db, 'nte_source')
    setPropertyRefs(db, 'nte_source', {
      father: ['memry://note/nte_dad'],
      attendees: ['memry://task/tsk_1', 'memry://event/evt_2'],
      email: 'john@doe.com'
    })

    const rows = getPropertyRefsForNote(db, 'nte_source')
    expect(rows).toHaveLength(3)
    expect(rows.filter((r) => r.propertyName === 'father')).toEqual([
      {
        sourceNoteId: 'nte_source',
        propertyName: 'father',
        targetType: 'note',
        targetId: 'nte_dad'
      }
    ])
  })

  it('ignores non-relation values', () => {
    insertTestNote(db, 'nte_source')
    setPropertyRefs(db, 'nte_source', { tags: ['a', 'b'], mixed: ['memry://note/nte_1', 'x'] })
    expect(getPropertyRefsForNote(db, 'nte_source')).toHaveLength(0)
  })

  it('replaces previous rows wholesale', () => {
    insertTestNote(db, 'nte_source')
    setPropertyRefs(db, 'nte_source', { father: ['memry://note/nte_old'] })
    setPropertyRefs(db, 'nte_source', { father: ['memry://note/nte_new'] })

    const rows = getPropertyRefsForNote(db, 'nte_source')
    expect(rows).toHaveLength(1)
    expect(rows[0].targetId).toBe('nte_new')
  })

  it('finds incoming refs by target', () => {
    insertTestNote(db, 'nte_a')
    insertTestNote(db, 'nte_b')
    setPropertyRefs(db, 'nte_a', { father: ['memry://note/nte_dad'] })
    setPropertyRefs(db, 'nte_b', { father: ['memry://note/nte_dad'] })

    const incoming = getIncomingPropertyRefs(db, 'note', 'nte_dad')
    expect(incoming.map((r) => r.sourceNoteId).sort()).toEqual(['nte_a', 'nte_b'])
  })

  it('is populated through setNoteProperties', () => {
    insertTestNote(db, 'nte_source')
    setNoteProperties(db, 'nte_source', { father: ['memry://note/nte_dad'] }, (name, value) =>
      inferPropertyType(name, value)
    )
    expect(getPropertyRefsForNote(db, 'nte_source')).toHaveLength(1)
  })

  it('clears refs through setNoteProperties when properties become empty', () => {
    insertTestNote(db, 'nte_source')
    const getType = (name: string, value: unknown) => inferPropertyType(name, value)

    setNoteProperties(db, 'nte_source', { father: ['memry://note/nte_dad'] }, getType)
    expect(getPropertyRefsForNote(db, 'nte_source')).toHaveLength(1)

    setNoteProperties(db, 'nte_source', {}, getType)
    expect(getPropertyRefsForNote(db, 'nte_source')).toHaveLength(0)
  })

  it('de-duplicates a repeated URI within one property', () => {
    insertTestNote(db, 'nte_source')
    setPropertyRefs(db, 'nte_source', {
      attendees: ['memry://task/tsk_1', 'memry://task/tsk_1']
    })

    const rows = getPropertyRefsForNote(db, 'nte_source')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      sourceNoteId: 'nte_source',
      propertyName: 'attendees',
      targetType: 'task',
      targetId: 'tsk_1'
    })
  })
})
