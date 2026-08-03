/**
 * Integration test for the Apple Journal importer.
 * Runs against synthetic HTML fixtures and a real temp vault + databases.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { VaultStatus, VaultConfig } from '@memry/contracts/vault-api'
import { startProjectionRuntime, stopProjectionRuntime } from '../../projections'
import { createNoteDerivedStateProjector } from '../../projections/projectors/note-derived-state-projector'

vi.mock('electron', () => {
  const send = vi.fn()
  return {
    BrowserWindow: {
      getAllWindows: vi.fn(() => [
        { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }
      ])
    },
    shell: { openPath: vi.fn(() => Promise.resolve('')), showItemInFolder: vi.fn() }
  }
})

vi.mock('../../inbox/suggestions', () => ({
  updateNoteEmbedding: vi.fn(() => Promise.resolve())
}))

const FIXTURES = path.join(__dirname, '__fixtures__')

describe('appleJournalImporter (integration)', () => {
  let tempVault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  let vaultIndex: typeof import('../../vault/index')
  let database: typeof import('../../database')
  let importer: typeof import('./apple-journal-importer')
  let importContext: typeof import('../import-context')

  beforeEach(async () => {
    tempVault = createTestVault('apple-journal-import-test')
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()

    vaultIndex = await import('../../vault/index')
    database = await import('../../database')

    vi.spyOn(vaultIndex, 'getStatus').mockReturnValue({
      isOpen: true,
      path: tempVault.path,
      isIndexing: false,
      indexProgress: 100,
      error: null
    } satisfies VaultStatus)

    vi.spyOn(vaultIndex, 'getConfig').mockReturnValue({
      excludePatterns: ['.git', 'node_modules', '.trash'],
      defaultNoteFolder: 'notes',
      journalFolder: 'journal',
      attachmentsFolder: 'attachments'
    } satisfies VaultConfig)

    vi.spyOn(database, 'getDatabase').mockReturnValue(dataDb.db)
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(indexDb.db)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {})

    startProjectionRuntime([createNoteDerivedStateProjector(() => tempVault.path)])

    importer = await import('./apple-journal-importer')
    importContext = await import('../import-context')
  })

  afterEach(async () => {
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    tempVault.cleanup()
  })

  it('imports two entries and skips index.html (3 files → 2 imported)', async () => {
    const sourcePaths = [
      path.join(FIXTURES, 'index.html'),
      path.join(FIXTURES, 'entry-1.html'),
      path.join(FIXTURES, 'entry-2.html')
    ]
    const ctx = importContext.createImportContext('it1', new AbortController().signal)
    const summary = await importer.appleJournalImporter.run({ sourcePaths }, ctx)

    expect(summary.failed).toEqual([])
    expect(summary.imported).toBe(2)
    expect(summary.skipped).toBe(1)
  })

  it('parses date from pageHeader → note title and date property', async () => {
    const sourcePaths = [path.join(FIXTURES, 'entry-1.html')]
    const ctx = importContext.createImportContext('it2', new AbortController().signal)
    await importer.appleJournalImporter.run({ sourcePaths }, ctx)

    const appleDir = path.join(tempVault.notesDir, 'Apple Journal')
    expect(fs.existsSync(appleDir)).toBe(true)

    const files = fs.readdirSync(appleDir)
    expect(files.some((f) => f.includes('2024-11-03'))).toBe(true)

    const noteFile = files.find((f) => f.includes('2024-11-03'))!
    const content = fs.readFileSync(path.join(appleDir, noteFile), 'utf8')
    expect(content).toContain('2024-11-03')
  })

  it('includes location in frontmatter from generic-map asset token', async () => {
    const sourcePaths = [path.join(FIXTURES, 'entry-1.html')]
    const ctx = importContext.createImportContext('it3', new AbortController().signal)
    await importer.appleJournalImporter.run({ sourcePaths }, ctx)

    const appleDir = path.join(tempVault.notesDir, 'Apple Journal')
    const files = fs.readdirSync(appleDir)
    const noteFile = files.find((f) => f.includes('2024-11-03'))!
    const content = fs.readFileSync(path.join(appleDir, noteFile), 'utf8')
    expect(content).toContain('location')
  })

  it('does not import photos (no attachments)', async () => {
    const sourcePaths = [path.join(FIXTURES, 'entry-1.html')]
    const ctx = importContext.createImportContext('it4', new AbortController().signal)
    const summary = await importer.appleJournalImporter.run({ sourcePaths }, ctx)

    expect(summary.attachments).toBe(0)
  })

  it('stops early when cancelled', async () => {
    const ac = new AbortController()
    ac.abort()
    const sourcePaths = [path.join(FIXTURES, 'entry-1.html'), path.join(FIXTURES, 'entry-2.html')]
    const ctx = importContext.createImportContext('it5', ac.signal)
    const summary = await importer.appleJournalImporter.run({ sourcePaths }, ctx)

    expect(summary.imported).toBe(0)
  })
})
