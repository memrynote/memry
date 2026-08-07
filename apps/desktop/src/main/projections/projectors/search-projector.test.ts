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

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  return { ...actual, default: { ...actual, readFile: readFileSpy }, readFile: readFileSpy }
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
