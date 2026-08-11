/**
 * Integration test for the Evernote importer orchestrator.
 * Runs against the synthetic sample.enex fixture and a real temp vault + databases.
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
      getAllWindows: vi.fn(() => [{ isDestroyed: () => false, webContents: { send } }])
    },
    shell: { openPath: vi.fn(() => Promise.resolve('')), showItemInFolder: vi.fn() }
  }
})

vi.mock('../../inbox/suggestions', () => ({
  updateNoteEmbedding: vi.fn(() => Promise.resolve())
}))

const FIXTURE = path.join(__dirname, '__fixtures__', 'sample.enex')

describe('evernoteImporter (integration)', () => {
  let tempVault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  let vaultIndex: typeof import('../../vault/index')
  let database: typeof import('../../database')
  let importer: typeof import('./evernote-importer')
  let importContext: typeof import('../import-context')

  beforeEach(async () => {
    tempVault = createTestVault('evernote-import-test')
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

    importer = await import('./evernote-importer')
    importContext = await import('../import-context')
  })

  afterEach(async () => {
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    tempVault.cleanup()
  })

  it('imports note under Evernote/sample folder with tags, checkbox, and attachment', async () => {
    const ctx = importContext.createImportContext('ev1', new AbortController().signal)
    const summary = await importer.evernoteImporter.run({ sourcePaths: [FIXTURE] }, ctx)

    expect(summary.failed).toEqual([])
    expect(summary.imported).toBe(1)
    expect(summary.attachments).toBe(1)

    // Note should be under Evernote/sample/ (notebook = basename of file)
    const evernoteDir = path.join(tempVault.notesDir, 'Evernote', 'sample')
    const noteFiles = fs.readdirSync(evernoteDir)
    expect(noteFiles.some((f) => f.includes('Sample Evernote Note'))).toBe(true)

    const notePath = path.join(evernoteDir, noteFiles.find((f) => f.endsWith('.md'))!)
    const content = fs.readFileSync(notePath, 'utf8')

    // Body text present
    expect(content).toContain('Hello from Evernote')

    // Checkbox items converted
    expect(content).toContain('[x]')
    expect(content).toContain('Finished task')
    expect(content).toContain('[ ]')
    expect(content).toContain('Pending task')

    // Tag applied
    expect(content).toContain('evernote-tag')

    // Image ref rewritten to vault path (memry-file://)
    expect(content).toContain('memry-file://')
    // Original placeholder should be gone
    expect(content).not.toContain('memry-enex:')
  })

  it('preserves Evernote timestamps on the imported note', async () => {
    const ctx = importContext.createImportContext('ev2', new AbortController().signal)
    await importer.evernoteImporter.run({ sourcePaths: [FIXTURE] }, ctx)

    const evernoteDir = path.join(tempVault.notesDir, 'Evernote', 'sample')
    const noteFiles = fs.readdirSync(evernoteDir)
    const noteFile = noteFiles.find((f) => f.endsWith('.md'))!

    // Created/modified dates from the enex now live on the note record, not in the file
    const row = indexDb.sqlite
      .prepare(
        'SELECT created_at AS createdAt, modified_at AS modifiedAt FROM note_cache WHERE path = ?'
      )
      .get(`notes/Evernote/sample/${noteFile}`) as
      | { createdAt: string; modifiedAt: string }
      | undefined
    expect(row?.createdAt).toContain('2023-10-15')
    expect(row?.modifiedAt).toContain('2023-10-16')
  })

  it('stops early when cancelled before processing', async () => {
    const ac = new AbortController()
    ac.abort()
    const ctx = importContext.createImportContext('ev3', ac.signal)
    const summary = await importer.evernoteImporter.run({ sourcePaths: [FIXTURE] }, ctx)
    expect(summary.imported).toBe(0)
  })
})
