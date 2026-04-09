import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
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

    const cached = indexDb.db
      .select()
      .from(noteCache)
      .where(eq(noteCache.id, 'missing-note'))
      .get()

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

    const cached = indexDb.db
      .select()
      .from(noteCache)
      .where(eq(noteCache.id, 'present-note'))
      .get()

    expect(cached).toEqual(expect.objectContaining({ id: 'present-note', path: relativePath }))
  })
})
