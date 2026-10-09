import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestDataDb,
  createTestIndexDb,
  sql,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { insertNoteCache, setNoteTags } from '@main/database/queries/notes'

const sync = vi.hoisted(() => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))
vi.mock('../sync/local-mutations', () => sync)
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

import * as database from '../database'
import {
  flushProjectionEvents,
  startProjectionRuntime,
  stopProjectionRuntime
} from '../projections'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import { backfillHeaderTagFlags } from './header-tag-backfill'

describe('backfillHeaderTagFlags', () => {
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  let vaultPath: string

  /** A note as a build before index migration 0024 left it: tag rows with no header flag. */
  const addOlderBuildNote = (
    id: string,
    relativePath: string,
    tags: string[],
    file: string | null,
    fileType: 'markdown' | 'pdf' = 'markdown'
  ): void => {
    if (file !== null) writeFileSync(path.join(vaultPath, relativePath), file)
    insertNoteCache(index.db, {
      id,
      path: relativePath,
      title: id,
      fileType,
      contentHash: `hash-${id}`,
      wordCount: 0,
      characterCount: 0,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z'
    })
    tags.forEach((tag, position) =>
      index.db.run(
        sql`INSERT INTO note_tags (note_id, tag, position) VALUES (${id}, ${tag}, ${position})`
      )
    )
    data.db
      .insert(noteMetadata)
      .values({
        id,
        path: relativePath,
        title: id,
        fileType,
        clock: { device: 1 },
        syncedAt: '2026-01-12T00:00:00.000Z',
        createdAt: '2026-01-10T00:00:00.000Z',
        modifiedAt: '2026-01-12T00:00:00.000Z'
      })
      .run()
  }

  const flags = (id: string): Array<{ tag: string; in_header: number | null }> =>
    index.db.all(sql`SELECT tag, in_header FROM note_tags WHERE note_id = ${id} ORDER BY position`)

  const unresolvedNotes = (): number =>
    index.db.all<{ n: number }>(
      sql`SELECT COUNT(DISTINCT note_id) AS n FROM note_tags WHERE in_header IS NULL`
    )[0].n

  const run = async (shouldStop = (): boolean => false): Promise<number | null> => {
    const result = await backfillHeaderTagFlags({
      getIndexDb: () => index.db,
      vaultPath,
      shouldStop
    })
    await flushProjectionEvents()
    return result
  }

  beforeEach(() => {
    data = createTestDataDb()
    index = createTestIndexDb()
    vaultPath = mkdtempSync(path.join(tmpdir(), 'memry-header-tags-'))
    mkdirSync(path.join(vaultPath, 'notes'))
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(index.db)
    startProjectionRuntime([createNoteDerivedStateProjector(() => vaultPath)])
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    data.close()
    index.close()
    rmSync(vaultPath, { recursive: true, force: true })
  })

  it('flags the tag rows an older build wrote from each file’s frontmatter', async () => {
    addOlderBuildNote(
      'nte_mixed',
      'notes/Mixed.md',
      ['Work', 'focus'],
      '---\ntags: [Work]\n---\nBody #focus\n'
    )
    addOlderBuildNote('nte_inline', 'notes/Inline.md', ['idea'], 'Plain #idea\n')
    addOlderBuildNote('nte_scan', 'notes/scan.pdf', ['receipts'], null, 'pdf')
    addOlderBuildNote('nte_gone', 'notes/Gone.md', ['lost'], null)
    addOlderBuildNote('nte_current', 'notes/Current.md', [], 'No tags here\n')
    setNoteTags(index.db, 'nte_current', { header: ['kept'], inline: [] })

    expect(await run()).toBe(3)

    expect(flags('nte_mixed')).toEqual([
      { tag: 'Work', in_header: 1 },
      { tag: 'focus', in_header: 0 }
    ])
    expect(flags('nte_inline')).toEqual([{ tag: 'idea', in_header: 0 }])
    expect(flags('nte_scan')).toEqual([{ tag: 'receipts', in_header: 1 }])
    expect(flags('nte_gone'), 'an unreadable file is retried on the next open').toEqual([
      { tag: 'lost', in_header: null }
    ])
    expect(flags('nte_current')).toEqual([{ tag: 'kept', in_header: 1 }])
  })

  it('resumes after a pass that stopped early', async () => {
    addOlderBuildNote('nte_a', 'notes/A.md', ['alpha'], '---\ntags: [alpha]\n---\n')
    addOlderBuildNote('nte_b', 'notes/B.md', ['beta'], 'Body #beta\n')
    addOlderBuildNote('nte_c', 'notes/C.md', ['gamma'], '---\ntags: [gamma]\n---\n')

    let checks = 0
    expect(await run(() => checks++ >= 1)).toBeNull()
    expect(unresolvedNotes()).toBe(2)

    expect(await run()).toBe(2)
    expect(unresolvedNotes()).toBe(0)
    expect(await run()).toBe(0)
  })

  it('queues no sync and leaves note metadata as it was', async () => {
    addOlderBuildNote(
      'nte_mixed',
      'notes/Mixed.md',
      ['Work', 'focus'],
      '---\ntags: [Work]\n---\nBody #focus\n'
    )
    const before = data.db.select().from(noteMetadata).all()

    await run()

    expect(flags('nte_mixed')[0]).toEqual({ tag: 'Work', in_header: 1 })
    expect(data.db.select().from(noteMetadata).all()).toEqual(before)
    expect(sync.enqueueLocalSyncCreate).not.toHaveBeenCalled()
    expect(sync.enqueueLocalSyncUpdate).not.toHaveBeenCalled()
    expect(sync.enqueueLocalSyncDelete).not.toHaveBeenCalled()
  })
})
