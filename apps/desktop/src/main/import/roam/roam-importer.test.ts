/**
 * Integration test for the Roam importer orchestrator.
 * Runs against a synthetic graph.json fixture and a real temp vault + databases.
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

const FIXTURE = path.join(__dirname, '__fixtures__', 'graph.json')

describe('roamImporter (integration)', () => {
  let tempVault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  let vaultIndex: typeof import('../../vault/index')
  let database: typeof import('../../database')
  let importer: typeof import('./roam-importer')
  let importContext: typeof import('../import-context')

  beforeEach(async () => {
    tempVault = createTestVault('roam-import-test')
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

    importer = await import('./roam-importer')
    importContext = await import('../import-context')
  })

  afterEach(async () => {
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    tempVault.cleanup()
  })

  it('imports all pages under the Roam folder with nested outline + markup', async () => {
    const ctx = importContext.createImportContext('it1', new AbortController().signal)
    const summary = await importer.roamImporter.run({ sourcePaths: [FIXTURE] }, ctx)

    expect(summary.failed).toEqual([])
    expect(summary.imported).toBe(3)

    const roamDir = path.join(tempVault.notesDir, 'Roam')
    expect(fs.existsSync(path.join(roamDir, 'Project Plan.md'))).toBe(true)
    expect(fs.existsSync(path.join(roamDir, 'Meeting Notes.md'))).toBe(true)

    const project = fs.readFileSync(path.join(roamDir, 'Project Plan.md'), 'utf8')

    // Nested outline: 2-space indent per depth level.
    expect(project).toContain('- # Overview')
    expect(project).toContain('  - Goals are *important* and ==urgent==')
    expect(project).toContain('    - [ ] Ship the importer')
    expect(project).toContain('    - [x] Write the parser')

    // Unknown templates (POMO, word-count) are dropped.
    expect(project).not.toContain('POMO')
    expect(project).not.toContain('word-count')
  })

  it('resolves a cross-page ((uid)) reference with the safe wikilink fallback', async () => {
    const ctx = importContext.createImportContext('it2', new AbortController().signal)
    await importer.roamImporter.run({ sourcePaths: [FIXTURE] }, ctx)

    const meeting = fs.readFileSync(
      path.join(tempVault.notesDir, 'Roam', 'Meeting Notes.md'),
      'utf8'
    )
    // ((blk-goals)) lives on "Project Plan" → wikilink + quoted (scrubbed) text.
    expect(meeting).toContain('[[Project Plan]]: "Goals are *important* and ==urgent=="')
    // No ^uid anchors are emitted.
    expect(meeting).not.toMatch(/\^[a-z0-9-]+/)
  })

  it('re-titles a daily-note page to the canonical journal date', async () => {
    const ctx = importContext.createImportContext('it3', new AbortController().signal)
    await importer.roamImporter.run({ sourcePaths: [FIXTURE] }, ctx)

    const daily = path.join(tempVault.notesDir, 'Roam', '2024-01-01.md')
    expect(fs.existsSync(daily)).toBe(true)
    expect(fs.readFileSync(daily, 'utf8')).toContain('- First entry of the year')
  })

  it('stops early when cancelled', async () => {
    const ac = new AbortController()
    ac.abort()
    const ctx = importContext.createImportContext('it4', ac.signal)
    const summary = await importer.roamImporter.run({ sourcePaths: [FIXTURE] }, ctx)
    expect(summary.imported).toBe(0)
  })
})
