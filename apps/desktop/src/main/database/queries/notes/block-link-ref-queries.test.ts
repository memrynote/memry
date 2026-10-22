import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { insertNoteCache } from './note-crud'
import { reindexNoteNames } from './note-names-queries'
import { getLinkUsage, setBlockLinkRefs } from './block-link-ref-queries'
import { getPortalUsage, setPortalRefs } from './portal-ref-queries'
import { setNoteLinks } from './link-queries'

describe('block usage from other notes', () => {
  let dbResult: TestDatabaseResult

  const addNote = (id: string, title = id): void => {
    insertNoteCache(dbResult.db, {
      id,
      path: `notes/${title}.md`,
      title,
      contentHash: `hash-${id}`,
      wordCount: 0,
      characterCount: 0,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z'
    })
    reindexNoteNames(dbResult.db, { noteId: id, title, aliases: { kind: 'read', aliases: [] } })
  }

  const portal = (host: string, ordinal: number, source: string, anchor: string | null) => ({
    hostNoteId: host,
    ordinal,
    sourceNoteId: source,
    anchor,
    root: 0,
    kind: anchor ? ('blocks' as const) : ('note' as const)
  })

  beforeEach(() => {
    dbResult = createTestIndexDb()
    addNote('src', 'Cell Biology')
    addNote('a', 'Lecture')
    addNote('b', 'Exam prep')
  })
  afterEach(() => dbResult.close())

  it('counts a [[Note#^anchor]] link from another note, by title or path form, for that block only', () => {
    setBlockLinkRefs(dbResult.db, 'a', [{ note: 'cell biology', anchor: 'chl-7f2a' }])
    setBlockLinkRefs(dbResult.db, 'b', [
      { note: 'notes/Cell Biology', anchor: 'chl-7f2a' },
      { note: 'Cell Biology', anchor: 'other-1' }
    ])
    expect(getLinkUsage(dbResult.db, 'src', 'chl-7f2a').map((row) => row.sourceNoteId)).toEqual([
      'b',
      'a'
    ])
    expect(getLinkUsage(dbResult.db, 'src', 'other-1').map((row) => row.sourceNoteId)).toEqual([
      'b'
    ])
    expect(getLinkUsage(dbResult.db, 'src', 'nothing')).toEqual([])
  })

  it('never counts the note itself', () => {
    setBlockLinkRefs(dbResult.db, 'src', [{ note: 'Cell Biology', anchor: 'chl-7f2a' }])
    setPortalRefs(dbResult.db, 'src', [portal('src', 0, 'src', 'chl-7f2a')])
    expect(getLinkUsage(dbResult.db, 'src', 'chl-7f2a')).toEqual([])
    expect(getPortalUsage(dbResult.db, 'src', 'chl-7f2a')).toEqual([])
  })

  it('counts other-note portals alongside', () => {
    setPortalRefs(dbResult.db, 'a', [portal('a', 0, 'src', 'chl-7f2a')])
    expect(getPortalUsage(dbResult.db, 'src', 'chl-7f2a').map((row) => row.hostNoteId)).toEqual([
      'a'
    ])
  })

  it('without an anchor lists every other note that links to the note', () => {
    setNoteLinks(dbResult.db, 'a', [{ targetTitle: 'Cell Biology', targetId: 'src' }])
    setNoteLinks(dbResult.db, 'src', [{ targetTitle: 'Cell Biology', targetId: 'src' }])
    expect(getLinkUsage(dbResult.db, 'src').map((row) => row.sourceNoteId)).toEqual(['a'])
  })

  it('replaces a source note rows wholesale', () => {
    setBlockLinkRefs(dbResult.db, 'a', [{ note: 'Cell Biology', anchor: 'chl-7f2a' }])
    setBlockLinkRefs(dbResult.db, 'a', [])
    expect(getLinkUsage(dbResult.db, 'src', 'chl-7f2a')).toEqual([])
  })
})
