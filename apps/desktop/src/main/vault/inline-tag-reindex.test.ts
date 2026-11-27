import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { and, eq } from 'drizzle-orm'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import type { VaultConfig } from '@memry/contracts/vault-api'
import { noteCache, noteTags } from '@memry/db-schema/schema/notes-cache'
import { getSetting } from '@main/database/queries/settings'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import { startProjectionRuntime, stopProjectionRuntime } from '../projections'
import * as database from '../database'
import { indexVault } from './indexer'
import { INLINE_TAG_REINDEX_KEY, reindexInlineTags } from './inline-tag-reindex'
import { PropertyDefinitionsService } from './property-definitions'

vi.mock('./status', () => ({
  getConfig: vi.fn((): VaultConfig => ({
    excludePatterns: [],
    defaultNoteFolder: 'notes',
    journalFolder: 'journal',
    journalDateFormat: 'YYYY-MM-DD',
    attachmentsFolder: 'attachments'
  })),
  emitIndexProgress: vi.fn()
}))

vi.mock('../inbox/suggestions', () => ({
  updateNoteEmbedding: vi.fn(() => Promise.resolve())
}))

vi.mock('../lib/window-broadcast', () => ({
  broadcastToAllWindows: vi.fn()
}))

describe('reindexInlineTags', () => {
  let vault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  const tagsOf = (file: string): string[] => {
    const note = indexDb.db.select().from(noteCache).where(eq(noteCache.path, file)).get()
    return indexDb.db
      .select({ tag: noteTags.tag })
      .from(noteTags)
      .where(eq(noteTags.noteId, note!.id))
      .all()
      .map((row) => row.tag)
      .toSorted()
  }

  /** The rows a build that read ASCII tags only left behind. */
  const forgetTag = (file: string, tag: string): void => {
    const note = indexDb.db.select().from(noteCache).where(eq(noteCache.path, file)).get()
    indexDb.db
      .delete(noteTags)
      .where(and(eq(noteTags.noteId, note!.id), eq(noteTags.tag, tag)))
      .run()
  }

  const run = (shouldStop = (): boolean => false) =>
    reindexInlineTags({
      dataDb: asClientDb(dataDb.db),
      getIndexDb: () => indexDb.db,
      vaultPath: vault.path,
      shouldStop
    })

  beforeEach(async () => {
    vault = createTestVault('inline-tag-reindex')
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    vi.spyOn(database, 'getDatabase').mockReturnValue(asClientDb(dataDb.db))
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(indexDb.db)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => undefined)
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])
    await PropertyDefinitionsService.init(vault.path).reload()

    fs.writeFileSync(path.join(vault.path, 'korean.md'), 'Meeting #퓨리 and #work\n')
    fs.writeFileSync(path.join(vault.path, 'latin.md'), 'Only #work\n')
    await indexVault(vault.path)
    forgetTag('korean.md', '퓨리')
  })

  afterEach(async () => {
    await stopProjectionRuntime({ drain: true })
    PropertyDefinitionsService.destroy()
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    vault.cleanup()
  })

  it('indexes the inline tags an older build left out, once', async () => {
    expect(tagsOf('korean.md')).toEqual(['work'])

    await expect(run()).resolves.toBe(1)

    expect(tagsOf('korean.md')).toEqual(['work', '퓨리'])
    expect(tagsOf('latin.md')).toEqual(['work'])
    expect(getSetting(asClientDb(dataDb.db), INLINE_TAG_REINDEX_KEY)).toBe('done')

    forgetTag('korean.md', '퓨리')
    await expect(run()).resolves.toBe(0)
    expect(tagsOf('korean.md')).toEqual(['work'])
  })

  it('resumes on the next open when the vault closes mid-pass', async () => {
    await expect(run(() => true)).resolves.toBeNull()
    expect(getSetting(asClientDb(dataDb.db), INLINE_TAG_REINDEX_KEY)).toBeNull()

    await expect(run()).resolves.toBe(1)
    expect(tagsOf('korean.md')).toEqual(['work', '퓨리'])
  })
})
