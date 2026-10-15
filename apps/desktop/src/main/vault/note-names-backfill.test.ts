import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestIndexDb, sql, type TestDatabaseResult } from '@tests/utils/test-db'
import { getOutgoingLinks, insertNoteCache, resolveLinkTargets } from '@main/database/queries/notes'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

import { backfillNoteNames } from './note-names-backfill'

describe('backfillNoteNames', () => {
  let index: TestDatabaseResult
  let vaultPath: string

  const addOlderBuildNote = (
    id: string,
    title: string,
    file: string,
    links: Array<{ targetTitle: string; targetId: string | null }> = []
  ): void => {
    writeFileSync(path.join(vaultPath, `${title}.md`), file)
    insertNoteCache(index.db, {
      id,
      path: `${title}.md`,
      title,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z'
    })
    for (const link of links) {
      index.db.run(
        sql`INSERT INTO note_links (source_id, target_id, target_title) VALUES (${id}, ${link.targetId}, ${link.targetTitle})`
      )
    }
  }

  const run = (): Promise<number | null> =>
    backfillNoteNames({ getIndexDb: () => index.db, vaultPath, shouldStop: () => false })

  beforeEach(() => {
    index = createTestIndexDb()
    vaultPath = mkdtempSync(path.join(tmpdir(), 'memry-note-names-backfill-'))
  })

  afterEach(() => {
    index.close()
    rmSync(vaultPath, { recursive: true, force: true })
  })

  it('names older notes from their files, resolves alias links, and reruns as a no-op', async () => {
    addOlderBuildNote('n-kaan', 'Kaan', '---\naliases:\n  - K.\n---\nHello\n')
    addOlderBuildNote('n-src', 'Source', 'See [[K.]] and [[Kaan]]\n', [
      { targetTitle: 'K.', targetId: null },
      { targetTitle: 'Kaan', targetId: 'n-kaan' }
    ])

    expect(await run()).toBe(2)
    const resolved = resolveLinkTargets(index.db, ['K.', 'kaan', 'Source'])
    expect([...resolved.values()].map((match) => match?.noteId ?? null)).toEqual([
      'n-kaan',
      'n-kaan',
      'n-src'
    ])
    expect(
      getOutgoingLinks(index.db, 'n-src').map((link) => [link.targetTitle, link.targetId])
    ).toEqual([
      ['K.', 'n-kaan'],
      ['Kaan', 'n-kaan']
    ])

    expect(await run()).toBe(0)
  })

  it('still names a note whose file cannot be read, by its title', async () => {
    addOlderBuildNote('n-gone', 'Gone', '---\naliases: [G]\n---\n')
    rmSync(path.join(vaultPath, 'Gone.md'))

    expect(await run()).toBe(1)
    expect(resolveLinkTargets(index.db, ['gone', 'G']).get('gone')?.noteId).toBe('n-gone')
    expect(resolveLinkTargets(index.db, ['G']).get('G')).toBeNull()
  })
})
