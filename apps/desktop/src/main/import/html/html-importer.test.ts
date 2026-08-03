/**
 * Integration test for the HTML importer orchestrator.
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

const FIXTURE_DIR = path.join(__dirname, '__fixtures__')
const PAGE_ONE = path.join(FIXTURE_DIR, 'page-one.html')
const PAGE_TWO = path.join(FIXTURE_DIR, 'page-two.html')

// Minimal valid PNG bytes (1×1 transparent)
const REMOTE_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

describe('htmlImporter (integration)', () => {
  let tempVault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  let vaultIndex: typeof import('../../vault/index')
  let database: typeof import('../../database')
  let importer: typeof import('./html-importer')
  let importContext: typeof import('../import-context')

  beforeEach(async () => {
    tempVault = createTestVault('html-import-test')
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

    // Mock global.fetch for remote image
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === 'https://cdn.example.com/remote.png') {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => REMOTE_PNG_BYTES.buffer
          } as unknown as Response
        }
        return { ok: false, status: 404 } as unknown as Response
      })
    )

    startProjectionRuntime([createNoteDerivedStateProjector(() => tempVault.path)])

    importer = await import('./html-importer')
    importContext = await import('../import-context')
  })

  afterEach(async () => {
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    indexDb.close()
    dataDb.close()
    tempVault.cleanup()
  })

  it('imports both HTML pages with correct vault folder, attachments, wikilinks, and inline data URI', async () => {
    const ctx = importContext.createImportContext('it1', new AbortController().signal)
    const summary = await importer.htmlImporter.run({ sourcePaths: [PAGE_ONE, PAGE_TWO] }, ctx)

    expect(summary.failed).toEqual([])
    // Two notes imported
    expect(summary.imported).toBe(2)
    // Two attachments: local.png + remote.png (data URI kept inline, not saved)
    expect(summary.attachments).toBe(2)

    const htmlDir = path.join(tempVault.notesDir, 'HTML')

    // Files use sanitized title as filename (spaces preserved, case preserved)
    expect(fs.existsSync(path.join(htmlDir, 'Page One.md'))).toBe(true)
    expect(fs.existsSync(path.join(htmlDir, 'Page Two.md'))).toBe(true)

    const pageOne = fs.readFileSync(path.join(htmlDir, 'Page One.md'), 'utf8')

    // Inter-file link → wikilink
    expect(pageOne).toContain('[[Page Two]]')

    // Local and remote images rewritten to vault attachment paths
    expect(pageOne).toContain('memry-file://')
    expect(pageOne).not.toContain('](local.png)')
    expect(pageOne).not.toContain('](https://cdn.example.com/remote.png)')

    // Data URI kept inline — not saved as attachment
    expect(pageOne).toContain('data:image/png;base64,')
  })

  it('stops early when cancelled', async () => {
    const ac = new AbortController()
    ac.abort()
    const ctx = importContext.createImportContext('it2', ac.signal)
    const summary = await importer.htmlImporter.run({ sourcePaths: [PAGE_ONE, PAGE_TWO] }, ctx)
    expect(summary.imported).toBe(0)
  })
})
