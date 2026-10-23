import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDataDb, asClientDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { DataDb } from '../database/types'
import {
  getLinkByBookId,
  getLinkByReaderDocumentId,
  listLinks,
  markLinkState,
  upsertLink
} from './links-repository'

describe('readwise links repository', () => {
  let result: TestDatabaseResult
  let db: DataDb

  beforeEach(() => {
    result = createTestDataDb()
    db = asClientDb(result.db)
  })
  afterEach(() => result.close())

  it('finds a link by book id and by Reader document id', () => {
    upsertLink(db, { readwiseBookId: 7, readerDocumentId: 'doc-1', noteId: 'n1' })
    expect(getLinkByBookId(db, 7)?.noteId).toBe('n1')
    expect(getLinkByReaderDocumentId(db, 'doc-1')?.noteId).toBe('n1')
    expect(getLinkByBookId(db, 8)).toBeUndefined()
  })

  it('moves an existing book to a new note instead of adding a second row', () => {
    upsertLink(db, { readwiseBookId: 7, noteId: 'n1' })
    upsertLink(db, { readwiseBookId: 7, noteId: 'n2' })
    expect(listLinks(db)).toHaveLength(1)
    expect(getLinkByBookId(db, 7)).toMatchObject({ noteId: 'n2', state: 'linked' })
  })

  it('gives a Reader-only link its book id later without a second row', () => {
    upsertLink(db, { readerDocumentId: 'doc-1', noteId: 'n1' })
    upsertLink(db, { readwiseBookId: 9, readerDocumentId: 'doc-1', noteId: 'n1' })
    expect(listLinks(db)).toHaveLength(1)
    expect(getLinkByBookId(db, 9)?.readerDocumentId).toBe('doc-1')
  })

  it('allows several Reader-only rows (NULL book ids)', () => {
    upsertLink(db, { readerDocumentId: 'a', noteId: 'n1' })
    upsertLink(db, { readerDocumentId: 'b', noteId: 'n2' })
    expect(listLinks(db)).toHaveLength(2)
  })

  it('rejects a link that names neither id', () => {
    expect(() => upsertLink(db, { noteId: 'n1' })).toThrow()
  })

  it('marks a link by book id, Reader id, or note id, and lists by state', () => {
    upsertLink(db, { readwiseBookId: 1, noteId: 'n1' })
    upsertLink(db, { readwiseBookId: 2, readerDocumentId: 'd2', noteId: 'n2' })
    upsertLink(db, { readwiseBookId: 3, noteId: 'n3' })

    markLinkState(db, { noteId: 'n1' }, 'note-deleted')
    markLinkState(db, { readerDocumentId: 'd2' }, 'source-deleted')

    expect(listLinks(db, 'note-deleted').map((l) => l.readwiseBookId)).toEqual([1])
    expect(listLinks(db, 'source-deleted').map((l) => l.readwiseBookId)).toEqual([2])
    expect(listLinks(db, 'linked').map((l) => l.readwiseBookId)).toEqual([3])
    expect(markLinkState(db, { readwiseBookId: 99 }, 'linked')).toBeUndefined()
  })
})
