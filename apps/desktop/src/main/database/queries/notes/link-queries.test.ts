import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TestDatabaseResult, TestDb } from '@tests/utils/test-db'
import { createTestIndexDb } from '@tests/utils/test-db'
import { insertNoteCache, deleteNoteCache } from './note-crud'
import { setNoteLinks, getIncomingReferences } from './link-queries'
import { resolveLinkTargets } from './wiki-target-resolver'
import { setPropertyRefs } from './property-ref-queries'

describe('getIncomingReferences', () => {
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

  it('includes property relations in incoming links', () => {
    insertTestNote(db, 'nte_dad')
    insertTestNote(db, 'nte_john')
    setPropertyRefs(db, 'nte_john', { father: ['memry://note/nte_dad'] })

    const incoming = getIncomingReferences(db, 'nte_dad')
    expect(incoming).toContainEqual(
      expect.objectContaining({
        sourceNoteId: 'nte_john',
        via: { kind: 'property', propertyName: 'father' }
      })
    )
  })

  it('still includes wiki links', () => {
    insertTestNote(db, 'nte_dad')
    insertTestNote(db, 'nte_note')
    setNoteLinks(db, 'nte_note', [{ targetTitle: 'Dad', targetId: 'nte_dad' }])

    const incoming = getIncomingReferences(db, 'nte_dad')
    expect(incoming.some((r) => r.sourceNoteId === 'nte_note' && r.via === undefined)).toBe(true)
  })

  it('does not duplicate a source that links both ways', () => {
    insertTestNote(db, 'nte_dad')
    insertTestNote(db, 'nte_john')
    setNoteLinks(db, 'nte_john', [{ targetTitle: 'Dad', targetId: 'nte_dad' }])
    setPropertyRefs(db, 'nte_john', { father: ['memry://note/nte_dad'] })

    const incoming = getIncomingReferences(db, 'nte_dad')
    expect(incoming.filter((r) => r.sourceNoteId === 'nte_john')).toHaveLength(2)
  })

  it('excludes a property ref whose source note no longer exists in note_cache', () => {
    insertTestNote(db, 'nte_dad')
    insertTestNote(db, 'nte_ghost')
    setPropertyRefs(db, 'nte_ghost', { father: ['memry://note/nte_dad'] })

    // Simulate the source note being deleted without its outgoing
    // property_refs rows being cleaned up (index DB has no FK enforcement).
    deleteNoteCache(db, 'nte_ghost')

    const incoming = getIncomingReferences(db, 'nte_dad')
    expect(incoming.some((r) => r.sourceNoteId === 'nte_ghost')).toBe(false)
  })
})

describe('path-form wiki-link targets (#2562)', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  const insertAt = (id: string, path: string, title: string): void => {
    insertNoteCache(db, {
      id,
      path,
      title,
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
    insertAt('nte_a', 'Work/Plan.md', 'Plan')
    insertAt('nte_b', 'Home/Plan.md', 'Plan')
    insertAt('nte_pdf', 'Docs/spec.pdf', 'spec')
  })

  afterEach(() => {
    dbResult.close()
  })

  it('resolves a vault-root path case-insensitively, with or without .md or a leading slash', () => {
    const queries = ['Home/Plan', 'home/PLAN', '/Work/Plan.md', 'Docs/spec.pdf', 'Nowhere/Plan']
    const resolved = resolveLinkTargets(db, queries)
    expect(queries.map((query) => resolved.get(query)?.noteId ?? null)).toEqual([
      'nte_b',
      'nte_b',
      'nte_a',
      'nte_pdf',
      null
    ])
  })
})
