import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { noteCache, noteLinks } from '@memry/db-schema/schema/notes-cache'
import { createTestIndexDb, sql, type TestDatabaseResult } from '@tests/utils/test-db'

const getIndexDatabase = vi.hoisted(() => vi.fn())

vi.mock('../../database', () => ({
  getIndexDatabase
}))

import { createNoteDerivedStateProjector } from './note-derived-state-projector'

describe('note derived state projector', () => {
  let indexDb: TestDatabaseResult
  let vaultDir: string

  beforeEach(() => {
    indexDb = createTestIndexDb()
    getIndexDatabase.mockReturnValue(indexDb.db)
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-note-projector-'))
  })

  afterEach(() => {
    indexDb.close()
    fs.rmSync(vaultDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  function seedCachedNote(noteId: string, relativePath: string): void {
    indexDb.db.run(sql`
      INSERT INTO note_cache (
        id,
        path,
        title,
        content_hash,
        word_count,
        character_count,
        snippet,
        created_at,
        modified_at
      )
      VALUES (
        ${noteId},
        ${relativePath},
        ${'Seed Note'},
        ${'hash'},
        ${1},
        ${4},
        ${'seed'},
        ${'2026-01-01T00:00:00.000Z'},
        ${'2026-01-01T00:00:00.000Z'}
      )
    `)
  }

  it('rebuild removes cached notes whose files no longer exist', async () => {
    seedCachedNote('missing-note', 'notes/missing.md')

    const projector = createNoteDerivedStateProjector(() => vaultDir)

    await projector.rebuild()

    const cached = indexDb.db.select().from(noteCache).where(eq(noteCache.id, 'missing-note')).get()

    expect(cached).toBeUndefined()
  })

  it('reconcile preserves cached notes whose files still exist', async () => {
    const relativePath = 'notes/present.md'
    const absolutePath = path.join(vaultDir, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, '# Present\n', 'utf8')
    seedCachedNote('present-note', relativePath)

    const projector = createNoteDerivedStateProjector(() => vaultDir)

    await projector.reconcile()

    const cached = indexDb.db.select().from(noteCache).where(eq(noteCache.id, 'present-note')).get()

    expect(cached).toEqual(expect.objectContaining({ id: 'present-note', path: relativePath }))
  })

  it('reconcile yields to the event loop instead of running the whole pass in one turn', async () => {
    for (let i = 0; i < 20; i++) {
      const relativePath = `notes/present-${i}.md`
      const absolutePath = path.join(vaultDir, relativePath)
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
      fs.writeFileSync(absolutePath, '# Present\n', 'utf8')
      seedCachedNote(`present-${i}`, relativePath)
    }

    const projector = createNoteDerivedStateProjector(() => vaultDir)

    let settled = false
    const pending = Promise.resolve(projector.reconcile()).then(() => {
      settled = true
    })

    // Three microtask ticks. A pass that stats synchronously has already
    // finished by now; one that awaits real file I/O cannot have.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(settled).toBe(false)

    await pending
  })

  it('reconcile keeps a cached note when the file check fails for a reason other than ENOENT', async () => {
    seedCachedNote('unreadable-note', 'notes/unreadable.md')

    const permissionError = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES'
    })
    const statSpy = vi.spyOn(fs.promises, 'stat').mockRejectedValue(permissionError)

    try {
      const projector = createNoteDerivedStateProjector(() => vaultDir)
      await projector.reconcile()
    } finally {
      statSpy.mockRestore()
    }

    const cached = indexDb.db
      .select()
      .from(noteCache)
      .where(eq(noteCache.id, 'unreadable-note'))
      .get()

    expect(cached).toBeDefined()
  })

  it('reconcile stops deleting when the index database is swapped mid-pass', async () => {
    seedCachedNote('missing-note', 'notes/missing.md')

    const otherIndexDb = createTestIndexDb()
    const statSpy = vi.spyOn(fs.promises, 'stat').mockImplementation(async () => {
      // A vault switch lands between reading the ids and applying the deletes.
      getIndexDatabase.mockReturnValue(otherIndexDb.db)
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    })

    try {
      const projector = createNoteDerivedStateProjector(() => vaultDir)
      await projector.reconcile()
    } finally {
      statSpy.mockRestore()
      getIndexDatabase.mockReturnValue(indexDb.db)
      otherIndexDb.close()
    }

    const cached = indexDb.db.select().from(noteCache).where(eq(noteCache.id, 'missing-note')).get()

    expect(cached).toBeDefined()
  })

  it('reconcile leaves a note alone when its cache row moved while the old path was checked', async () => {
    seedCachedNote('renamed-note', 'notes/old-name.md')

    const statSpy = vi.spyOn(fs.promises, 'stat').mockImplementation(async () => {
      // The note is renamed on disk (and reindexed) while the old path is checked.
      const movedPath = path.join(vaultDir, 'notes/new-name.md')
      fs.mkdirSync(path.dirname(movedPath), { recursive: true })
      fs.writeFileSync(movedPath, '# Renamed\n', 'utf8')
      indexDb.db.run(
        sql`UPDATE note_cache SET path = ${'notes/new-name.md'}, indexed_at = ${'2026-02-02T00:00:00.000Z'} WHERE id = ${'renamed-note'}`
      )
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    })

    try {
      const projector = createNoteDerivedStateProjector(() => vaultDir)
      await projector.reconcile()
    } finally {
      statSpy.mockRestore()
    }

    const cached = indexDb.db.select().from(noteCache).where(eq(noteCache.id, 'renamed-note')).get()

    expect(cached).toEqual(expect.objectContaining({ path: 'notes/new-name.md' }))
  })

  it('project clears stale outbound links when a note no longer contains wiki links', async () => {
    seedCachedNote('source-note', 'notes/source.md')
    indexDb.db.run(sql`
      INSERT INTO note_links (source_id, target_id, target_title)
      VALUES (${'source-note'}, ${'target-note'}, ${'Old Link'})
    `)

    const projector = createNoteDerivedStateProjector(() => vaultDir)

    await projector.project({
      type: 'note.upserted',
      note: {
        kind: 'markdown',
        noteId: 'source-note',
        path: 'notes/source.md',
        title: 'Source',
        fileType: 'markdown',
        localOnly: false,
        contentHash: 'updated-hash',
        wordCount: 4,
        characterCount: 21,
        snippet: 'plain text',
        date: null,
        emoji: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-02T00:00:00.000Z',
        parsedContent: 'Plain text with no links',
        tags: [],
        properties: {},
        wikiLinks: []
      }
    })

    const links = indexDb.db
      .select()
      .from(noteLinks)
      .where(eq(noteLinks.sourceId, 'source-note'))
      .all()

    expect(links).toEqual([])
  })
})
