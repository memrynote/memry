import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { initializeFts } from '../../database/fts'
import { initializeFtsTasks } from '../../database/fts-tasks'
import { initializeFtsInbox, getFtsInboxCount } from '../../database/fts-inbox'
import { getFtsCount } from '../../database/fts'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'

const getDatabase = vi.hoisted(() => vi.fn())
const getIndexDatabase = vi.hoisted(() => vi.fn())
const getAllWindows = vi.hoisted(() => vi.fn())
const readFileSpy = vi.hoisted(() => vi.fn())
const statSpy = vi.hoisted(() => vi.fn())

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  return {
    ...actual,
    default: { ...actual, readFile: readFileSpy, stat: statSpy },
    readFile: readFileSpy,
    stat: statSpy
  }
})

vi.mock('../../database', async () => {
  const actual = await vi.importActual<typeof import('../../database')>('../../database')
  return {
    ...actual,
    getDatabase,
    getIndexDatabase
  }
})

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows
  }
}))

import { createSearchProjector } from './search-projector'

describe('search projector', () => {
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult
  let vaultDir: string

  beforeEach(() => {
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    getDatabase.mockReturnValue(dataDb.db)
    getIndexDatabase.mockReturnValue(indexDb.db)
    getAllWindows.mockReturnValue([])
    initializeFts(indexDb.db as never)
    initializeFtsTasks(dataDb.db as never)
    initializeFtsInbox(dataDb.db as never)
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-search-projector-'))
    readFileSpy.mockImplementation(async (filePath: string, encoding: BufferEncoding) =>
      fs.readFileSync(filePath, encoding)
    )
    statSpy.mockImplementation(async (filePath: string) => fs.statSync(filePath))
  })

  afterEach(() => {
    dataDb.close()
    indexDb.close()
    fs.rmSync(vaultDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  function seedMarkdownNote(
    noteId: string,
    relativePath: string,
    content: string,
    tags: string[]
  ): void {
    const absolutePath = path.join(vaultDir, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(
      absolutePath,
      `---\nid: ${noteId}\ntitle: Searchable Note\ntags:\n${tags.map((tag) => `  - ${tag}`).join('\n')}\ncreated: 2026-01-01T00:00:00.000Z\nmodified: 2026-01-01T00:00:00.000Z\n---\n${content}\n`,
      'utf8'
    )

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
        ${'Searchable Note'},
        ${'hash'},
        ${3},
        ${content.length},
        ${content.slice(0, 20)},
        ${'2026-01-01T00:00:00.000Z'},
        ${'2026-01-01T00:00:00.000Z'}
      )
    `)

    for (const tag of tags) {
      indexDb.db.run(sql`
        INSERT INTO note_tags (note_id, tag)
        VALUES (${noteId}, ${tag})
      `)
    }
  }

  function seedTask(taskId: string): void {
    dataDb.db.run(sql`
      INSERT INTO projects (id, name, position)
      VALUES (${'project-1'}, ${'Project'}, ${0})
    `)
    dataDb.db.run(sql`
      INSERT INTO tasks (id, project_id, title, description, position)
      VALUES (${taskId}, ${'project-1'}, ${'Task title'}, ${'Task body'}, ${0})
    `)
    dataDb.db.run(sql`
      INSERT INTO task_tags (task_id, tag)
      VALUES (${taskId}, ${'focus'})
    `)
  }

  const DEDUPE_MARKER_KEY = 'search.ftsDedupeVersion'

  function readDedupeMarker(): string | undefined {
    return dataDb.db.get<{ value: string }>(
      sql`SELECT value FROM settings WHERE key = ${DEDUPE_MARKER_KEY}`
    )?.value
  }

  /**
   * What an install upgraded from a build with the append bug looks like: three
   * rows per id, the newest carrying the current content.
   */
  function seedDuplicateFtsRows(): void {
    for (const content of ['oldest', 'middle', 'newest']) {
      indexDb.db.run(sql`
        INSERT INTO fts_notes (id, title, content, tags)
        VALUES (${'note-1'}, ${'Searchable Note'}, ${content}, ${'alpha'})
      `)
      dataDb.db.run(sql`
        INSERT INTO fts_tasks (id, title, description, tags)
        VALUES (${'task-1'}, ${'Task title'}, ${content}, ${'focus'})
      `)
      dataDb.db.run(sql`
        INSERT INTO fts_inbox (id, title, content, transcription, source_title)
        VALUES (${'inbox-1'}, ${'Inbox title'}, ${content}, ${''}, ${'Source'})
      `)
    }
  }

  function seedInboxItem(itemId: string): void {
    dataDb.db.run(sql`
      INSERT INTO inbox_items (id, type, title, content, source_title, created_at, modified_at)
      VALUES (
        ${itemId},
        ${'note'},
        ${'Inbox title'},
        ${'Inbox body'},
        ${'Source'},
        ${'2026-01-01T00:00:00.000Z'},
        ${'2026-01-01T00:00:00.000Z'}
      )
    `)
  }

  it('rebuild repopulates note, task, and inbox FTS tables from canonical sources', async () => {
    seedMarkdownNote('note-1', 'notes/searchable.md', 'Projection rebuild content', ['alpha'])
    seedTask('task-1')
    seedInboxItem('inbox-1')

    const projector = createSearchProjector(() => vaultDir)

    await expect(projector.rebuild()).resolves.toEqual(
      expect.objectContaining({ notes: 1, tasks: 1, inbox: 1 })
    )
    expect(getFtsCount(indexDb.db as never)).toBe(1)
    expect(getFtsInboxCount(dataDb.db as never)).toBe(1)
    expect(
      dataDb.db.get<{ count: number }>(sql`SELECT COUNT(*) as count FROM fts_tasks`)?.count
    ).toBe(1)
  })

  it('reconcile replaces stale FTS rows with rebuilt state', async () => {
    seedMarkdownNote('note-1', 'notes/searchable.md', 'Fresh rebuilt content', ['alpha'])
    seedTask('task-1')
    seedInboxItem('inbox-1')

    indexDb.db.run(sql`
      INSERT INTO fts_notes (id, title, content, tags)
      VALUES (${'stale-note'}, ${'Stale'}, ${'stale'}, ${'stale'})
    `)
    dataDb.db.run(sql`
      INSERT INTO fts_tasks (id, title, description, tags)
      VALUES (${'stale-task'}, ${'Stale'}, ${'stale'}, ${'stale'})
    `)
    dataDb.db.run(sql`
      INSERT INTO fts_inbox (id, title, content, transcription, source_title)
      VALUES (${'stale-inbox'}, ${'Stale'}, ${'stale'}, ${''}, ${''})
    `)

    const projector = createSearchProjector(() => vaultDir)

    await projector.reconcile()

    expect(
      indexDb.db.get<{ count: number }>(sql`SELECT COUNT(*) as count FROM fts_notes`)?.count
    ).toBe(1)
    expect(
      dataDb.db.get<{ count: number }>(sql`SELECT COUNT(*) as count FROM fts_tasks`)?.count
    ).toBe(1)
    expect(getFtsInboxCount(dataDb.db as never)).toBe(1)
  })

  it('projecting the same note, task, and inbox item twice leaves one row each', async () => {
    seedTask('task-1')
    seedInboxItem('inbox-1')

    const projector = createSearchProjector(() => vaultDir)
    const noteEvent = {
      type: 'note.upserted',
      note: {
        kind: 'markdown',
        noteId: 'note-1',
        path: 'notes/searchable.md',
        title: 'Searchable Note',
        fileType: 'markdown',
        localOnly: false,
        contentHash: 'hash',
        wordCount: 2,
        characterCount: 10,
        snippet: 'first pass',
        date: null,
        emoji: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-01T00:00:00.000Z',
        parsedContent: 'first pass',
        tags: ['alpha'],
        properties: {},
        wikiLinks: []
      }
    } as const

    // Every save republishes the same upsert. Twice must not mean two rows.
    await projector.project(noteEvent)
    await projector.project({
      ...noteEvent,
      note: { ...noteEvent.note, parsedContent: 'second pass' }
    })
    await projector.project({ type: 'task.upserted', taskId: 'task-1' })
    await projector.project({ type: 'task.upserted', taskId: 'task-1' })
    await projector.project({ type: 'inbox.upserted', itemId: 'inbox-1' })
    await projector.project({ type: 'inbox.upserted', itemId: 'inbox-1' })

    expect(getFtsCount(indexDb.db as never)).toBe(1)
    expect(
      dataDb.db.get<{ count: number }>(sql`SELECT COUNT(*) as count FROM fts_tasks`)?.count
    ).toBe(1)
    expect(getFtsInboxCount(dataDb.db as never)).toBe(1)
    expect(
      indexDb.db.all<{ id: string }>(sql`SELECT id FROM fts_notes WHERE fts_notes MATCH ${'first'}`)
    ).toHaveLength(0)
  })

  it('leaves a note out of the index until its body has been read', async () => {
    // #given the projection vault ingest publishes from `stat` alone: identity
    // only, every body-derived field null
    const projector = createSearchProjector(() => vaultDir)
    const statOnlyEvent = {
      type: 'note.upserted',
      note: {
        kind: 'markdown',
        noteId: 'note-1',
        path: 'notes/pasted.md',
        title: 'Pasted',
        fileType: 'markdown',
        localOnly: false,
        contentHash: null,
        wordCount: null,
        characterCount: null,
        snippet: null,
        date: null,
        emoji: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-01T00:00:00.000Z',
        parsedContent: null,
        tags: [],
        properties: {},
        wikiLinks: []
      }
    } as const

    // #when
    await projector.project(statOnlyEvent)

    // #then no FTS write happens on the add path at all
    expect(getFtsCount(indexDb.db as never)).toBe(0)

    // #when the backfill republishes the same note with its body
    await projector.project({
      ...statOnlyEvent,
      note: { ...statOnlyEvent.note, parsedContent: 'measured at last', wordCount: 3 }
    })

    // #then it becomes searchable
    expect(
      indexDb.db.all<{ id: string }>(
        sql`SELECT id FROM fts_notes WHERE fts_notes MATCH ${'measured'}`
      )
    ).toHaveLength(1)
  })

  it('reconcile sweeps duplicate rows left behind by earlier versions', async () => {
    seedMarkdownNote('note-1', 'notes/searchable.md', 'Disk content', ['alpha'])
    seedTask('task-1')
    seedInboxItem('inbox-1')
    seedDuplicateFtsRows()

    readFileSpy.mockClear()

    const projector = createSearchProjector(() => vaultDir)
    await projector.reconcile()

    expect(getFtsCount(indexDb.db as never)).toBe(1)
    expect(
      dataDb.db.get<{ count: number }>(sql`SELECT COUNT(*) as count FROM fts_tasks`)?.count
    ).toBe(1)
    expect(getFtsInboxCount(dataDb.db as never)).toBe(1)

    // The surviving row is the most recent write, not the oldest.
    expect(
      indexDb.db.get<{ content: string }>(sql`SELECT content FROM fts_notes WHERE id = ${'note-1'}`)
        ?.content
    ).toBe('newest')
    expect(
      dataDb.db.get<{ description: string }>(
        sql`SELECT description FROM fts_tasks WHERE id = ${'task-1'}`
      )?.description
    ).toBe('newest')
    expect(
      dataDb.db.get<{ content: string }>(sql`SELECT content FROM fts_inbox WHERE id = ${'inbox-1'}`)
        ?.content
    ).toBe('newest')

    // Deduping is not an excuse to re-read the vault.
    expect(readFileSpy).not.toHaveBeenCalled()
  })

  it('runs the duplicate sweep once and skips it on every later open', async () => {
    seedMarkdownNote('note-1', 'notes/searchable.md', 'Disk content', ['alpha'])
    seedTask('task-1')
    seedInboxItem('inbox-1')
    seedDuplicateFtsRows()

    const projector = createSearchProjector(() => vaultDir)
    await projector.reconcile()

    expect(getFtsCount(indexDb.db as never)).toBe(1)
    expect(readDedupeMarker()).toBe('1')

    // The sweep is a full fts5 scan and the defect it repairs can only happen
    // once, so a completed sweep must never scan again. Proven with a row a
    // second sweep would have removed.
    indexDb.db.run(sql`
      INSERT INTO fts_notes (id, title, content, tags)
      VALUES (${'note-1'}, ${'Searchable Note'}, ${'sneaked in'}, ${'alpha'})
    `)
    await projector.reconcile()

    expect(getFtsCount(indexDb.db as never)).toBe(2)
  })

  it('leaves the dedupe marker unset when the sweep fails part-way through', async () => {
    seedMarkdownNote('note-1', 'notes/searchable.md', 'Disk content', ['alpha'])
    seedTask('task-1')
    seedInboxItem('inbox-1')
    seedDuplicateFtsRows()

    // Stand-in for the process dying mid-sweep: the notes and tasks tables are
    // swept, then the inbox one blows up before the marker would be written.
    dataDb.db.run(sql`DROP TABLE fts_inbox`)

    const projector = createSearchProjector(() => vaultDir)
    await expect(projector.reconcile()).rejects.toThrow()

    expect(readDedupeMarker()).toBeUndefined()

    // Next open finishes the job rather than treating it as already done.
    initializeFtsInbox(dataDb.db as never)
    dataDb.db.run(sql`
      INSERT INTO fts_inbox (id, title, content, transcription, source_title)
      VALUES (${'inbox-1'}, ${'Inbox title'}, ${'dup'}, ${''}, ${'Source'})
    `)
    dataDb.db.run(sql`
      INSERT INTO fts_inbox (id, title, content, transcription, source_title)
      VALUES (${'inbox-1'}, ${'Inbox title'}, ${'dup'}, ${''}, ${'Source'})
    `)

    await projector.reconcile()

    expect(getFtsInboxCount(dataDb.db as never)).toBe(1)
    expect(readDedupeMarker()).toBe('1')
  })

  it('leaves the dedupe marker unset when the pass is interrupted, so the next open retries', async () => {
    seedMarkdownNote('note-1', 'notes/searchable.md', 'Disk content', ['alpha'])
    seedTask('task-1')
    seedInboxItem('inbox-1')
    seedDuplicateFtsRows()

    const controller = new AbortController()
    controller.abort()

    const projector = createSearchProjector(() => vaultDir)
    await projector.reconcile(controller.signal)

    expect(readDedupeMarker()).toBeUndefined()
    expect(getFtsCount(indexDb.db as never)).toBe(3)

    // Next open picks the work back up.
    await projector.reconcile()

    expect(getFtsCount(indexDb.db as never)).toBe(1)
    expect(readDedupeMarker()).toBe('1')
  })

  it('reconcile leaves an already-consistent index alone: no FTS teardown, no disk re-scan', async () => {
    seedMarkdownNote('note-1', 'notes/searchable.md', 'Disk content', ['alpha'])
    seedTask('task-1')
    seedInboxItem('inbox-1')

    // Warm index: every canonical row is already indexed. Content deliberately
    // differs from disk so a re-scan would be visible in the assertions below.
    indexDb.db.run(sql`
      INSERT INTO fts_notes (id, title, content, tags)
      VALUES (${'note-1'}, ${'Searchable Note'}, ${'already indexed'}, ${'alpha'})
    `)
    dataDb.db.run(sql`
      INSERT INTO fts_tasks (id, title, description, tags)
      VALUES (${'task-1'}, ${'Task title'}, ${'already indexed'}, ${'focus'})
    `)
    dataDb.db.run(sql`
      INSERT INTO fts_inbox (id, title, content, transcription, source_title)
      VALUES (${'inbox-1'}, ${'Inbox title'}, ${'already indexed'}, ${''}, ${'Source'})
    `)

    readFileSpy.mockClear()

    const projector = createSearchProjector(() => vaultDir)
    await projector.reconcile()

    expect(readFileSpy).not.toHaveBeenCalled()
    expect(
      indexDb.db.get<{ content: string }>(sql`SELECT content FROM fts_notes WHERE id = ${'note-1'}`)
        ?.content
    ).toBe('already indexed')
    expect(
      dataDb.db.get<{ description: string }>(
        sql`SELECT description FROM fts_tasks WHERE id = ${'task-1'}`
      )?.description
    ).toBe('already indexed')
    expect(
      dataDb.db.get<{ content: string }>(sql`SELECT content FROM fts_inbox WHERE id = ${'inbox-1'}`)
        ?.content
    ).toBe('already indexed')
  })

  it('reconcile refreshes a note whose file changed on disk while the cache went stale', async () => {
    // indexFile() returns 'skipped' for any path already in note_cache without
    // comparing mtimes, and the watcher only starts afterwards, so a note edited
    // outside Memry while the app was closed has a stale cache row by
    // construction. Reconcile is the pass that repairs search for it.
    seedMarkdownNote('note-1', 'notes/searchable.md', 'Old content', ['alpha'])
    indexDb.db.run(sql`
      INSERT INTO fts_notes (id, title, content, tags)
      VALUES (${'note-1'}, ${'Searchable Note'}, ${'Old content'}, ${'alpha'})
    `)
    indexDb.db.run(
      sql`UPDATE note_cache SET indexed_at = ${'2026-01-01T00:00:00.000Z'} WHERE id = ${'note-1'}`
    )

    // Edited outside Memry: newer file bytes, cache untouched.
    fs.writeFileSync(
      path.join(vaultDir, 'notes/searchable.md'),
      `---\nid: note-1\ntitle: Searchable Note\ntags:\n  - alpha\ncreated: 2026-01-01T00:00:00.000Z\nmodified: 2026-01-01T00:00:00.000Z\n---\nEdited outside Memry\n`,
      'utf8'
    )

    const projector = createSearchProjector(() => vaultDir)
    await projector.reconcile()

    expect(
      indexDb.db.get<{ content: string }>(sql`SELECT content FROM fts_notes WHERE id = ${'note-1'}`)
        ?.content
    ).toContain('Edited outside Memry')
    expect(
      indexDb.db.get<{ count: number }>(
        sql`SELECT COUNT(*) as count FROM fts_notes WHERE fts_notes MATCH ${'Memry'}`
      )?.count
    ).toBe(1)
  })

  it('reconcile stops statting the vault once its abort signal fires', async () => {
    // 65 rows = two stat batches, so the second batch is only reached if the
    // pass ignores the abort. Every row is stale, so an abort that is ignored
    // also shows up as a file read.
    for (let i = 0; i < 65; i++) {
      seedMarkdownNote(`note-${i}`, `notes/note-${i}.md`, `Content ${i}`, ['alpha'])
      indexDb.db.run(sql`
        INSERT INTO fts_notes (id, title, content, tags)
        VALUES (${`note-${i}`}, ${'Searchable Note'}, ${`Content ${i}`}, ${'alpha'})
      `)
    }
    indexDb.db.run(sql`UPDATE note_cache SET indexed_at = ${'2026-01-01T00:00:00.000Z'}`)

    const controller = new AbortController()
    statSpy.mockClear()
    readFileSpy.mockClear()
    statSpy.mockImplementation(async (filePath: string) => {
      controller.abort()
      return fs.statSync(filePath)
    })

    const projector = createSearchProjector(() => vaultDir)
    await projector.reconcile(controller.signal)

    expect(statSpy.mock.calls.length).toBeLessThanOrEqual(64)
    expect(readFileSpy).not.toHaveBeenCalled()
  })

  it('reconcile stops reading the vault once its abort signal fires', async () => {
    for (let i = 0; i < 4; i++) {
      seedMarkdownNote(`note-${i}`, `notes/note-${i}.md`, `Content ${i}`, ['alpha'])
    }

    // Orphan rows that a completed pass would have swept away.
    dataDb.db.run(sql`
      INSERT INTO fts_tasks (id, title, description, tags)
      VALUES (${'stale-task'}, ${'Stale'}, ${'stale'}, ${'stale'})
    `)
    dataDb.db.run(sql`
      INSERT INTO fts_inbox (id, title, content, transcription, source_title)
      VALUES (${'stale-inbox'}, ${'Stale'}, ${'stale'}, ${''}, ${''})
    `)

    const controller = new AbortController()
    readFileSpy.mockClear()
    readFileSpy.mockImplementation(async (filePath: string, encoding: BufferEncoding) => {
      controller.abort()
      return fs.readFileSync(filePath, encoding)
    })

    const projector = createSearchProjector(() => vaultDir)
    await projector.reconcile(controller.signal)

    expect(readFileSpy).toHaveBeenCalledTimes(1)
    // Nothing is written after the abort either — the database may already be
    // closed. The next open re-runs the same diff and finishes the backfill.
    expect(
      indexDb.db.get<{ count: number }>(sql`SELECT COUNT(*) as count FROM fts_notes`)?.count
    ).toBe(0)
    expect(
      dataDb.db.get<{ count: number }>(sql`SELECT COUNT(*) as count FROM fts_tasks`)?.count
    ).toBe(1)
    expect(getFtsInboxCount(dataDb.db as never)).toBe(1)
  })
})
