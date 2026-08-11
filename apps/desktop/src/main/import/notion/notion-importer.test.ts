/**
 * Integration test for the Notion importer orchestrator.
 * Runs against the synthetic export fixture and a real temp vault + databases.
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

const FIXTURE = path.join(__dirname, '__fixtures__', 'notion-export.zip')

describe('notionImporter (integration)', () => {
  let tempVault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  let vaultIndex: typeof import('../../vault/index')
  let database: typeof import('../../database')
  let importer: typeof import('./notion-importer')
  let importContext: typeof import('../import-context')

  beforeEach(async () => {
    tempVault = createTestVault('notion-import-test')
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

    importer = await import('./notion-importer')
    importContext = await import('../import-context')
  })

  afterEach(async () => {
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    tempVault.cleanup()
  })

  it('imports the export into a nested Notion folder with attachment + tags', async () => {
    const ctx = importContext.createImportContext('it1', new AbortController().signal)
    const summary = await importer.notionImporter.run({ sourcePaths: [FIXTURE] }, ctx)

    expect(summary.failed).toEqual([])
    expect(summary.imported).toBe(3)
    expect(summary.attachments).toBe(1)

    const notionDir = path.join(tempVault.notesDir, 'Notion')
    expect(fs.existsSync(path.join(notionDir, 'Parent Page.md'))).toBe(true)
    expect(fs.existsSync(path.join(notionDir, 'Parent Page', 'Child Page.md'))).toBe(true)
    expect(fs.existsSync(path.join(notionDir, 'Tasks DB.md'))).toBe(true)

    const tasks = fs.readFileSync(path.join(notionDir, 'Tasks DB.md'), 'utf8')
    expect(tasks).toContain('work')
    expect(tasks).toContain('home')

    const parent = fs.readFileSync(path.join(notionDir, 'Parent Page.md'), 'utf8')
    expect(parent).toContain('[[Child Page]]')
    expect(parent).toContain('- [x] finished item')
    // The image ref was rewritten to a saved vault attachment.
    expect(parent).toContain('memry-file://')
  })

  it('preserves Notion timestamps on the imported note', async () => {
    const ctx = importContext.createImportContext('it2', new AbortController().signal)
    await importer.notionImporter.run({ sourcePaths: [FIXTURE] }, ctx)

    // Timestamps now live on the note record, not in the file.
    const row = indexDb.sqlite
      .prepare('SELECT created_at AS createdAt FROM note_cache WHERE path = ?')
      .get('notes/Notion/Parent Page/Child Page.md') as { createdAt: string } | undefined
    // Child Page was created March 5, 2024 in the export.
    expect(row?.createdAt).toContain('2024-03-05')
  })

  it('stops early when cancelled', async () => {
    const ac = new AbortController()
    ac.abort()
    const ctx = importContext.createImportContext('it3', ac.signal)
    const summary = await importer.notionImporter.run({ sourcePaths: [FIXTURE] }, ctx)
    expect(summary.imported).toBe(0)
  })
})
