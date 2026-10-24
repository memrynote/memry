import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createTestDataDb,
  createTestIndexDb,
  asClientDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { noteCache, noteProperties } from '@memry/db-schema/schema/notes-cache'
import type { DataDb, IndexDb } from '../database/types'
import {
  getLinkByBookId,
  getLinkByReaderDocumentId,
  listLinks,
  upsertLink
} from './links-repository'
import { parseReadwiseUrl, rebuildLinks } from './rebuild-links'

describe('rebuildLinks', () => {
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  let db: DataDb
  let indexDb: IndexDb

  beforeEach(() => {
    data = createTestDataDb()
    index = createTestIndexDb()
    db = asClientDb(data.db)
    indexDb = index.db
  })
  afterEach(() => {
    data.close()
    index.close()
  })

  function addNote(noteId: string, props: Record<string, string>): void {
    indexDb
      .insert(noteCache)
      .values({
        id: noteId,
        path: `${noteId}.md`,
        title: noteId,
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-01T00:00:00.000Z'
      })
      .run()
    for (const [name, value] of Object.entries(props)) {
      indexDb.insert(noteProperties).values({ noteId, name, value, type: 'text' }).run()
    }
  }

  it('parses book and Reader urls and ignores others', () => {
    expect(parseReadwiseUrl('https://readwise.io/bookreview/123')).toEqual({ readwiseBookId: 123 })
    expect(parseReadwiseUrl('https://read.readwise.io/read/01abc')).toEqual({
      readerDocumentId: '01abc'
    })
    expect(parseReadwiseUrl('https://example.com/bookreview/1')).toBeNull()
    expect(parseReadwiseUrl('https://readwise.io/bookreview/abc')).toBeNull()
  })

  it('restores the table from note properties after it was cleared', () => {
    addNote('n1', { readwise_url: 'https://readwise.io/bookreview/101' })
    addNote('n2', { readwise_url: 'https://read.readwise.io/read/doc-2' })
    addNote('n3', { title: 'plain note' })
    upsertLink(db, { readwiseBookId: 101, noteId: 'n1' })
    result_clear(data)
    expect(listLinks(db)).toHaveLength(0)

    expect(rebuildLinks(db, indexDb)).toBe(2)

    expect(getLinkByBookId(db, 101)).toMatchObject({ noteId: 'n1', state: 'linked' })
    expect(getLinkByReaderDocumentId(db, 'doc-2')).toMatchObject({ noteId: 'n2', state: 'linked' })
  })

  it('follows a renamed note id and keeps source-deleted rows', () => {
    addNote('n-new', { readwise_url: 'https://readwise.io/bookreview/5' })
    addNote('n-b', { readwise_url: 'https://readwise.io/bookreview/6' })
    upsertLink(db, { readwiseBookId: 5, noteId: 'n-old' })
    upsertLink(db, { readwiseBookId: 6, noteId: 'n-b', state: 'source-deleted' })

    rebuildLinks(db, indexDb)

    expect(getLinkByBookId(db, 5)?.noteId).toBe('n-new')
    expect(getLinkByBookId(db, 6)?.state).toBe('source-deleted')
  })

  it('revives a note-deleted row whose note is back, and is stable when run twice', () => {
    addNote('n1', { readwise_url: 'https://readwise.io/bookreview/1' })
    upsertLink(db, { readwiseBookId: 1, noteId: 'n1', state: 'note-deleted' })
    rebuildLinks(db, indexDb)
    rebuildLinks(db, indexDb)
    expect(listLinks(db)).toHaveLength(1)
    expect(getLinkByBookId(db, 1)?.state).toBe('linked')
  })

  it('picks the lowest note id when two notes name one book', () => {
    addNote('n-b', { readwise_url: 'https://readwise.io/bookreview/8' })
    addNote('n-a', { readwise_url: 'https://readwise.io/bookreview/8' })
    rebuildLinks(db, indexDb)
    expect(getLinkByBookId(db, 8)?.noteId).toBe('n-a')
  })
})

function result_clear(data: TestDatabaseResult): void {
  data.sqlite.prepare('DELETE FROM readwise_links').run()
}
