import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { noteLinks } from '@memry/db-schema/schema/notes-cache'
import { reindexNoteNames } from '@main/database/queries/notes'
import { createTestIndexDb, sql, type TestDatabaseResult } from '@tests/utils/test-db'

const getIndexDatabase = vi.hoisted(() => vi.fn())
const broadcastToAllWindows = vi.hoisted(() => vi.fn())

vi.mock('../../database', () => ({
  getIndexDatabase
}))

vi.mock('../../lib/window-broadcast', () => ({
  broadcastToAllWindows
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
        headerTags: [],
        properties: {},
        aliases: [],
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

  function seedExtractedText(noteId: string, source: string, method: string, text: string): void {
    indexDb.db.run(sql`
      INSERT INTO extracted_text (note_id, source, part, method, text)
      VALUES (${noteId}, ${source}, 1, ${method}, ${text})
    `)
  }

  function outboundLinks(noteId: string): Array<{ targetId: string | null; targetTitle: string }> {
    return indexDb.db
      .select({ targetId: noteLinks.targetId, targetTitle: noteLinks.targetTitle })
      .from(noteLinks)
      .where(eq(noteLinks.sourceId, noteId))
      .orderBy(noteLinks.targetTitle)
      .all()
  }

  function upsertMarkdown(noteId: string, relativePath: string, wikiLinks: string[]) {
    return {
      type: 'note.upserted' as const,
      note: {
        kind: 'markdown' as const,
        noteId,
        path: relativePath,
        title: 'Source',
        fileType: 'markdown' as const,
        localOnly: false,
        contentHash: 'hash',
        wordCount: 1,
        characterCount: 1,
        snippet: '',
        date: null,
        emoji: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-02T00:00:00.000Z',
        parsedContent: wikiLinks.map((title) => `[[${title}]]`).join(' '),
        tags: [],
        headerTags: [],
        properties: {},
        aliases: [],
        wikiLinks
      }
    }
  }

  it('project adds the wiki links inside the note HTML blocks to its outbound links', async () => {
    seedCachedNote('source-note', 'notes/source.md')
    seedCachedNote('harbor-note', 'notes/harbor.md')
    indexDb.db.run(sql`UPDATE note_cache SET title = 'Harbor Log' WHERE id = 'harbor-note'`)
    reindexNoteNames(indexDb.db, {
      noteId: 'harbor-note',
      title: 'Harbor Log',
      aliases: { kind: 'read', aliases: [] }
    })
    seedExtractedText('source-note', 'chart.html', 'html', 'See [[Harbor Log]] and [[Plan]]')
    seedExtractedText('source-note', 'shot.png', 'ocr', 'A screenshot of [[Not A Link]]')

    const projector = createNoteDerivedStateProjector(() => vaultDir)
    await projector.project(upsertMarkdown('source-note', 'notes/source.md', ['Plan']))

    expect(outboundLinks('source-note')).toEqual([
      { targetId: 'harbor-note', targetTitle: 'Harbor Log' },
      { targetId: null, targetTitle: 'Plan' }
    ])
  })

  it('project refreshes outbound links from the note file when its HTML block text changes', async () => {
    const relativePath = 'notes/source.md'
    fs.mkdirSync(path.join(vaultDir, 'notes'), { recursive: true })
    fs.writeFileSync(path.join(vaultDir, relativePath), '---\ntitle: Source\n---\nSee [[Plan]]\n')
    seedCachedNote('source-note', relativePath)
    const projector = createNoteDerivedStateProjector(() => vaultDir)
    await projector.project(upsertMarkdown('source-note', relativePath, ['Plan']))

    seedExtractedText('source-note', 'chart.html', 'html', 'Tide table for [[Harbor Log]]')
    expect(projector.handles({ type: 'note.text-extracted', noteId: 'source-note' })).toBe(true)
    await projector.project({ type: 'note.text-extracted', noteId: 'source-note' })
    expect(outboundLinks('source-note')).toEqual([
      { targetId: null, targetTitle: 'Harbor Log' },
      { targetId: null, targetTitle: 'Plan' }
    ])

    indexDb.db.run(sql`DELETE FROM extracted_text WHERE note_id = 'source-note'`)
    await projector.project({ type: 'note.text-extracted', noteId: 'source-note' })
    expect(outboundLinks('source-note')).toEqual([{ targetId: null, targetTitle: 'Plan' }])
  })

  it('project tells open notes their links changed when HTML block links are added or removed', async () => {
    const relativePath = 'notes/source.md'
    fs.mkdirSync(path.join(vaultDir, 'notes'), { recursive: true })
    fs.writeFileSync(path.join(vaultDir, relativePath), '---\ntitle: Source\n---\nSee [[Plan]]\n')
    seedCachedNote('source-note', relativePath)
    seedCachedNote('harbor-note', 'notes/harbor.md')
    indexDb.db.run(sql`UPDATE note_cache SET title = 'Harbor Log' WHERE id = 'harbor-note'`)
    reindexNoteNames(indexDb.db, {
      noteId: 'harbor-note',
      title: 'Harbor Log',
      aliases: { kind: 'read', aliases: [] }
    })
    const projector = createNoteDerivedStateProjector(() => vaultDir)
    await projector.project(upsertMarkdown('source-note', relativePath, ['Plan']))
    broadcastToAllWindows.mockClear()

    const updatedIds = () =>
      broadcastToAllWindows.mock.calls
        .filter(([channel]) => channel === 'notes:updated')
        .map(([, event]) => {
          expect(event).toEqual({ id: expect.any(String), changes: {}, source: 'internal' })
          return (event as { id: string }).id
        })
        .sort()

    seedExtractedText('source-note', 'chart.html', 'html', 'Tide table for [[Harbor Log]]')
    await projector.project({ type: 'note.text-extracted', noteId: 'source-note' })
    expect(updatedIds()).toEqual(['harbor-note', 'source-note'])

    broadcastToAllWindows.mockClear()
    await projector.project({ type: 'note.text-extracted', noteId: 'source-note' })
    expect(updatedIds()).toEqual([])

    indexDb.db.run(sql`DELETE FROM extracted_text WHERE note_id = 'source-note'`)
    await projector.project({ type: 'note.text-extracted', noteId: 'source-note' })
    expect(updatedIds()).toEqual(['harbor-note', 'source-note'])
  })

  it('project keeps outbound links when the note file cannot be read after its HTML text changes', async () => {
    seedCachedNote('source-note', 'notes/missing.md')
    indexDb.db.run(sql`
      INSERT INTO note_links (source_id, target_id, target_title)
      VALUES (${'source-note'}, NULL, ${'Plan'})
    `)

    const projector = createNoteDerivedStateProjector(() => vaultDir)
    await projector.project({ type: 'note.text-extracted', noteId: 'source-note' })

    expect(outboundLinks('source-note')).toEqual([{ targetId: null, targetTitle: 'Plan' }])
  })

  it('project keeps outbound links instead of reading a note file linked outside the vault (#2969)', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-note-projector-outside-'))
    const secret = path.join(outside, 'private.md')
    fs.writeFileSync(secret, 'Outside secret [[Outside Secret]]\n')
    fs.mkdirSync(path.join(vaultDir, 'notes'), { recursive: true })
    fs.symlinkSync(secret, path.join(vaultDir, 'notes/source.md'))
    seedCachedNote('source-note', 'notes/source.md')
    indexDb.db.run(sql`
      INSERT INTO note_links (source_id, target_id, target_title)
      VALUES (${'source-note'}, NULL, ${'Plan'})
    `)

    try {
      const projector = createNoteDerivedStateProjector(() => vaultDir)
      await projector.project({ type: 'note.text-extracted', noteId: 'source-note' })

      expect(outboundLinks('source-note')).toEqual([{ targetId: null, targetTitle: 'Plan' }])
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('project backfills a backlink retroactively when the linked note is created later (#2209)', async () => {
    // The master note was saved first, while "New Note" did not exist yet:
    // an unresolved outbound link, target_id null.
    seedCachedNote('master-note', 'notes/master.md')
    indexDb.db.run(sql`
      INSERT INTO note_links (source_id, target_id, target_title, target_key)
      VALUES (${'master-note'}, NULL, ${'New Note'}, ${'new note'})
    `)

    const projector = createNoteDerivedStateProjector(() => vaultDir)

    // Create-from-link creates the note; this is that note's projection event.
    await projector.project({
      type: 'note.upserted',
      note: {
        kind: 'markdown',
        noteId: 'new-note',
        path: 'notes/new-note.md',
        title: 'New Note',
        fileType: 'markdown',
        localOnly: false,
        contentHash: 'hash',
        wordCount: 0,
        characterCount: 0,
        snippet: '',
        date: null,
        emoji: null,
        createdAt: '2026-01-02T00:00:00.000Z',
        modifiedAt: '2026-01-02T00:00:00.000Z',
        parsedContent: '',
        tags: [],
        headerTags: [],
        properties: {},
        aliases: [],
        wikiLinks: []
      }
    })

    const links = indexDb.db
      .select()
      .from(noteLinks)
      .where(eq(noteLinks.sourceId, 'master-note'))
      .all()

    expect(links).toEqual([
      expect.objectContaining({
        sourceId: 'master-note',
        targetId: 'new-note',
        targetTitle: 'New Note'
      })
    ])
  })

  it('project stores the cover, keeps it when the frontmatter was not read, and clears it', async () => {
    const projector = createNoteDerivedStateProjector(() => vaultDir)
    const coverOf = (): string | null | undefined =>
      indexDb.db.all<{ cover: string | null }>(
        sql`SELECT cover FROM note_cache WHERE id = 'book-note'`
      )[0]?.cover
    const upsert = (cover: string | null | undefined) => {
      const event = upsertMarkdown('book-note', 'Books/Dune.md', [])
      return { ...event, note: { ...event.note, cover } }
    }

    await projector.project(upsert('attachments/dune.jpg'))
    expect(coverOf()).toBe('attachments/dune.jpg')

    await projector.project(upsert(undefined))
    expect(coverOf()).toBe('attachments/dune.jpg')

    await projector.project(upsert(null))
    expect(coverOf()).toBeNull()
  })

  it('project stores the body task ids in document order and keeps them when the body was not read', async () => {
    const projector = createNoteDerivedStateProjector(() => vaultDir)
    const taskIdsOf = (): string | null | undefined =>
      indexDb.db.all<{ task_ids: string | null }>(
        sql`SELECT task_ids FROM note_cache WHERE id = 'build-note'`
      )[0]?.task_ids
    const upsert = (parsedContent: string | null) => {
      const event = upsertMarkdown('build-note', 'Carport/Build.md', [])
      return { ...event, note: { ...event.note, parsedContent } }
    }

    await projector.project(
      upsert(
        '- [x] 1. Start build {task:t-start}\n  - [ ] Pour {task:t-pour}\n- [ ] 2. Check {task:t-check}'
      )
    )
    expect(taskIdsOf()).toBe('["t-start","t-pour","t-check"]')

    await projector.project(upsert(null))
    expect(taskIdsOf()).toBe('["t-start","t-pour","t-check"]')

    await projector.project(upsert('No tasks left.'))
    expect(taskIdsOf()).toBe('[]')
  })
})
