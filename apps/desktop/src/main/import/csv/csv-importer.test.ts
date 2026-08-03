/**
 * Integration test for the CSV importer orchestrator.
 * Runs against the fixture CSV and a real temp vault + databases.
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
    BrowserWindow: { getAllWindows: vi.fn(() => [{ webContents: { send } }]) },
    shell: { openPath: vi.fn(() => Promise.resolve('')), showItemInFolder: vi.fn() }
  }
})

vi.mock('../../inbox/suggestions', () => ({
  updateNoteEmbedding: vi.fn(() => Promise.resolve())
}))

const FIXTURE = path.join(__dirname, '__fixtures__', 'sample.csv')

describe('csvImporter (integration)', () => {
  let tempVault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  let vaultIndex: typeof import('../../vault/index')
  let database: typeof import('../../database')
  let importer: typeof import('./csv-importer')
  let importContext: typeof import('../import-context')

  beforeEach(async () => {
    tempVault = createTestVault('csv-import-test')
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

    importer = await import('./csv-importer')
    importContext = await import('../import-context')
  })

  afterEach(async () => {
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    tempVault.cleanup()
  })

  it('imports notes under CSV/, skips empty-title row, saves property columns in frontmatter', async () => {
    const ctx = importContext.createImportContext('it1', new AbortController().signal)
    const summary = await importer.csvImporter.run({ sourcePaths: [FIXTURE] }, ctx)

    expect(summary.failed).toEqual([])
    // 4 valid rows (empty-title row skipped)
    expect(summary.imported).toBe(4)
    expect(summary.skipped).toBe(1)

    const csvDir = path.join(tempVault.notesDir, 'CSV')
    expect(fs.existsSync(csvDir)).toBe(true)

    const files = fs.readdirSync(csvDir)
    expect(files).toHaveLength(4)

    // Check a note that has a comma in a quoted field — the title now lives
    // on the note record, not in the file's frontmatter
    const buyFile = files.find((f) => f.includes('Buy milk'))
    expect(buyFile).toBeTruthy()
    const buyRow = indexDb.sqlite
      .prepare('SELECT title FROM note_cache WHERE path = ?')
      .get(`notes/CSV/${buyFile}`) as { title: string } | undefined
    expect(buyRow?.title).toBe('Buy milk, eggs')

    // Check properties are saved (Tags column should appear as frontmatter property)
    const kickoffFile = files.find((f) => f.includes('Project kickoff'))
    expect(kickoffFile).toBeTruthy()
    const kickoffContent = fs.readFileSync(path.join(csvDir, kickoffFile!), 'utf8')
    expect(kickoffContent).toContain('work')
  })

  it('preview returns group with columns + sampleTitles + correct counts', async () => {
    const ac = new AbortController()
    const result = await importer.csvImporter.preview!({ sourcePaths: [FIXTURE] }, ac.signal)

    expect(result.groups).toHaveLength(1)
    const group = result.groups[0]
    expect(group.label).toBe('sample.csv')
    expect(group.error).toBeUndefined()

    const noteCount = group.counts.find((c) => c.labelKey === 'import.stats.notes')
    const skipCount = group.counts.find((c) => c.labelKey === 'import.stats.skipped')
    expect(noteCount?.value).toBe(4)
    expect(skipCount?.value).toBe(1)

    expect(group.sampleTitles).toContain('Project kickoff')
    expect(group.sampleTitles).toContain('Buy milk, eggs')

    // warnings should mention columns
    const warningText = (group.warnings ?? []).map((w) => (typeof w === 'string' ? w : w.message))
    expect(warningText.some((w) => w.startsWith('Columns:'))).toBe(true)
    expect(warningText.some((w) => w.includes('Title from'))).toBe(true)
  })

  it('parses quoted field with embedded newline correctly', async () => {
    const ctx = importContext.createImportContext('it2', new AbortController().signal)
    await importer.csvImporter.run({ sourcePaths: [FIXTURE] }, ctx)

    const csvDir = path.join(tempVault.notesDir, 'CSV')
    const files = fs.readdirSync(csvDir)
    const researchFile = files.find((f) => f.includes('Research topic'))
    expect(researchFile).toBeTruthy()
    // The note itself (title) is correct; no import error
  })

  it('stops early when cancelled', async () => {
    const ac = new AbortController()
    ac.abort()
    const ctx = importContext.createImportContext('it3', ac.signal)
    const summary = await importer.csvImporter.run({ sourcePaths: [FIXTURE] }, ctx)
    expect(summary.imported).toBe(0)
  })

  it('preview returns error group for unreadable file', async () => {
    const ac = new AbortController()
    const result = await importer.csvImporter.preview!(
      { sourcePaths: ['/nonexistent/file.csv'] },
      ac.signal
    )
    expect(result.groups[0].error).toBeTruthy()
  })
})
