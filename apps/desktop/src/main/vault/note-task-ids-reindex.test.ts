import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TestDatabaseResult } from '@tests/utils/test-db'
import { asClientDb, createTestDataDb, createTestIndexDb } from '@tests/utils/test-db'
import { getNoteCacheById, insertNoteCache } from '@main/database/queries/notes'
import { getSetting } from '@main/database/queries/settings'
import { NOTE_TASK_IDS_REINDEX_KEY, reindexNoteTaskIds } from './note-task-ids-reindex'

describe('reindexNoteTaskIds', () => {
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  let vaultPath: string

  const addNote = (id: string, body: string): void => {
    const relativePath = `Carport/${id}.md`
    writeFileSync(path.join(vaultPath, relativePath), `---\nstatus: open\n---\n${body}\n`)
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

  const taskIdsOf = (id: string): string[] | null | undefined =>
    getNoteCacheById(index.db, id)?.taskIds

  const run = (shouldStop = (): boolean => false) =>
    reindexNoteTaskIds({
      dataDb: asClientDb(data.db),
      getIndexDb: () => index.db,
      vaultPath,
      shouldStop
    })

  beforeEach(() => {
    data = createTestDataDb()
    index = createTestIndexDb()
    vaultPath = mkdtempSync(path.join(tmpdir(), 'memry-note-task-ids-'))
    mkdirSync(path.join(vaultPath, 'Carport'))

    addNote('build', '- [x] 1. Start build {task:t-start}\n- [ ] 2. Check plan {task:t-check}')
    addNote('plain', 'Just prose.')
  })

  afterEach(() => {
    data.close()
    index.close()
    rmSync(vaultPath, { recursive: true, force: true })
  })

  it('indexes the task order of notes indexed before the column existed, once', async () => {
    expect(await run()).toBe(2)

    expect(taskIdsOf('build')).toEqual(['t-start', 't-check'])
    expect(taskIdsOf('plain')).toEqual([])
    expect(getSetting(asClientDb(data.db), NOTE_TASK_IDS_REINDEX_KEY)).toBe('done')

    addNote('later', '- [ ] Later {task:t-later}')
    expect(await run()).toBe(0)
    expect(taskIdsOf('later')).toBeNull()
  })

  it('leaves the marker unset when stopped, so the next open resumes', async () => {
    expect(await run(() => true)).toBeNull()
    expect(getSetting(asClientDb(data.db), NOTE_TASK_IDS_REINDEX_KEY)).toBeNull()
    expect(taskIdsOf('build')).toBeNull()
  })
})
