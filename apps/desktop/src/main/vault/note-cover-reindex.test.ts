import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TestDatabaseResult } from '@tests/utils/test-db'
import { asClientDb, createTestDataDb, createTestIndexDb } from '@tests/utils/test-db'
import { getNoteCacheById, insertNoteCache } from '@main/database/queries/notes'
import { getSetting } from '@main/database/queries/settings'
import { NOTE_COVER_REINDEX_KEY, reindexNoteCovers } from './note-cover-reindex'

describe('reindexNoteCovers', () => {
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  let vaultPath: string

  const addNote = (id: string, frontmatter: string): void => {
    const relativePath = `Books/${id}.md`
    writeFileSync(path.join(vaultPath, relativePath), `---\n${frontmatter}\n---\nBody\n`)
    insertNoteCache(index.db, {
      id,
      path: relativePath,
      title: id,
      contentHash: `hash-${id}`,
      wordCount: 1,
      characterCount: 4,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z'
    })
  }

  const coverOf = (id: string): string | null | undefined => getNoteCacheById(index.db, id)?.cover

  const run = (shouldStop = (): boolean => false) =>
    reindexNoteCovers({
      dataDb: asClientDb(data.db),
      getIndexDb: () => index.db,
      vaultPath,
      shouldStop
    })

  beforeEach(() => {
    data = createTestDataDb()
    index = createTestIndexDb()
    vaultPath = mkdtempSync(path.join(tmpdir(), 'memry-note-covers-'))
    mkdirSync(path.join(vaultPath, 'Books'))

    addNote('dune', 'cover: attachments/dune.jpg')
    addNote('emma', 'cover: wash:sage')
    addNote('hardback', 'cover: Hardback')
    addNote('plain', 'status: reading')
  })

  afterEach(() => {
    data.close()
    index.close()
    rmSync(vaultPath, { recursive: true, force: true })
  })

  it('indexes the covers of notes indexed before the column existed, once', async () => {
    expect(await run()).toBe(2)

    expect(coverOf('dune')).toBe('attachments/dune.jpg')
    expect(coverOf('emma')).toBe('wash:sage')
    expect(coverOf('hardback')).toBeNull()
    expect(coverOf('plain')).toBeNull()
    expect(getSetting(asClientDb(data.db), NOTE_COVER_REINDEX_KEY)).toBe('done')

    addNote('later', 'cover: attachments/later.png')
    expect(await run()).toBe(0)
    expect(coverOf('later')).toBeNull()
  })

  it('leaves the marker unset when stopped, so the next open resumes', async () => {
    expect(await run(() => true)).toBeNull()
    expect(getSetting(asClientDb(data.db), NOTE_COVER_REINDEX_KEY)).toBeNull()
    expect(coverOf('dune')).toBeNull()
  })
})
