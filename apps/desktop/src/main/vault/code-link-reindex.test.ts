import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TestDatabaseResult } from '@tests/utils/test-db'
import { asClientDb, createTestDataDb, createTestIndexDb } from '@tests/utils/test-db'
import { getOutgoingLinks, insertNoteCache, setNoteLinks } from '@main/database/queries/notes'
import { saveExtractedPart } from '@main/database/queries/extracted-text'
import { getSetting } from '@main/database/queries/settings'
import { CODE_LINK_REINDEX_KEY, reindexCodeLinks } from './code-link-reindex'

describe('reindexCodeLinks', () => {
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  let vaultPath: string

  const addNote = (id: string, title: string, body: string): void => {
    const relativePath = `notes/${title}.md`
    writeFileSync(path.join(vaultPath, relativePath), `---\nid: ${id}\n---\n${body}\n`)
    insertNoteCache(index.db, {
      id,
      path: relativePath,
      title,
      contentHash: `hash-${id}`,
      wordCount: 0,
      characterCount: 0,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z'
    })
  }

  const linksOf = (id: string): Array<[string, string | null]> =>
    getOutgoingLinks(index.db, id).map((link) => [link.targetTitle, link.targetId])

  const run = (shouldStop = (): boolean => false) =>
    reindexCodeLinks({
      dataDb: asClientDb(data.db),
      getIndexDb: () => index.db,
      vaultPath,
      shouldStop
    })

  beforeEach(() => {
    data = createTestDataDb()
    index = createTestIndexDb()
    vaultPath = mkdtempSync(path.join(tmpdir(), 'memry-code-links-'))
    mkdirSync(path.join(vaultPath, 'notes'))

    addNote('nte_guide', 'Guide', 'Plain text')
    addNote('nte_docs', 'Docs', 'Write `[[Example]]` to link, or see [[Guide]].')
    addNote('nte_plain', 'Plain', 'See [[Guide]].')
    setNoteLinks(index.db, 'nte_docs', [
      { targetTitle: 'Example' },
      { targetTitle: 'Guide', targetId: 'nte_guide' }
    ])
    setNoteLinks(index.db, 'nte_plain', [{ targetTitle: 'Stale' }])
  })

  afterEach(() => {
    data.close()
    index.close()
    rmSync(vaultPath, { recursive: true, force: true })
  })

  it('rewrites the links of notes with link syntax in code, once', async () => {
    expect(await run()).toBe(1)

    expect(linksOf('nte_docs')).toEqual([['Guide', 'nte_guide']])
    expect(linksOf('nte_plain')).toEqual([['Stale', null]])
    expect(getSetting(asClientDb(data.db), CODE_LINK_REINDEX_KEY)).toBe('done')

    setNoteLinks(index.db, 'nte_docs', [{ targetTitle: 'Example' }])
    expect(await run()).toBe(0)
    expect(linksOf('nte_docs')).toEqual([['Example', null]])
  })

  it('rewrites a CRLF note whose link syntax sits in a fenced block', async () => {
    writeFileSync(
      path.join(vaultPath, 'notes/Docs.md'),
      ['---', 'id: nte_docs', '---', '```', '[[Example]]', '```', 'See [[Guide]].', ''].join('\r\n')
    )

    expect(await run()).toBe(1)
    expect(linksOf('nte_docs')).toEqual([['Guide', 'nte_guide']])
  })

  it('keeps the links in the note HTML blocks when it rewrites a note', async () => {
    saveExtractedPart(
      index.db,
      { noteId: 'nte_docs', source: 'chart.html' },
      1,
      'html',
      'Read [[Guide]] and [[Harbor Log]]'
    )

    expect(await run()).toBe(1)
    expect(linksOf('nte_docs')).toEqual([
      ['Guide', 'nte_guide'],
      ['Harbor Log', null]
    ])
  })

  it('leaves the marker unset when stopped, so the next open resumes', async () => {
    expect(await run(() => true)).toBeNull()

    expect(linksOf('nte_docs')).toEqual([
      ['Example', null],
      ['Guide', 'nte_guide']
    ])
    expect(getSetting(asClientDb(data.db), CODE_LINK_REINDEX_KEY)).toBeNull()
  })
})
