/**
 * Integration test for the Google Keep importer orchestrator.
 * Runs against a synthetic keep-export.zip fixture and a real temp vault + databases.
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

const FIXTURE = path.join(__dirname, '__fixtures__', 'keep-export.zip')

describe('googleKeepImporter (integration)', () => {
  let tempVault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  let vaultIndex: typeof import('../../vault/index')
  let database: typeof import('../../database')
  let importer: typeof import('./google-keep-importer')
  let importContext: typeof import('../import-context')

  beforeEach(async () => {
    tempVault = createTestVault('keep-import-test')
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

    importer = await import('./google-keep-importer')
    importContext = await import('../import-context')
  })

  afterEach(async () => {
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    tempVault.cleanup()
  })

  it('imports text note, checklist note, and attachment note from the zip', async () => {
    const ctx = importContext.createImportContext('it1', new AbortController().signal)
    const summary = await importer.googleKeepImporter.run({ sourcePaths: [FIXTURE] }, ctx)

    expect(summary.failed).toEqual([])
    // 3 JSON notes imported; .html skipped
    expect(summary.imported).toBe(3)
    // 1 attachment (photo.gif)
    expect(summary.attachments).toBe(1)

    const keepDir = path.join(tempVault.notesDir, 'Google Keep')
    expect(fs.existsSync(keepDir)).toBe(true)

    // All three notes should be files somewhere under Google Keep/
    const files = fs.readdirSync(keepDir)
    const mdFiles = files.filter((f) => f.endsWith('.md'))
    expect(mdFiles.length).toBe(3)
  })

  it('renders checkboxes correctly in the checklist note', async () => {
    const ctx = importContext.createImportContext('it2', new AbortController().signal)
    await importer.googleKeepImporter.run({ sourcePaths: [FIXTURE] }, ctx)

    const keepDir = path.join(tempVault.notesDir, 'Google Keep')
    const shoppingFile = path.join(keepDir, 'Shopping.md')
    expect(fs.existsSync(shoppingFile)).toBe(true)

    const content = fs.readFileSync(shoppingFile, 'utf8')
    expect(content).toContain('- [ ] Milk')
    expect(content).toContain('- [x] Eggs')
    expect(content).toContain('- [ ] Butter')
  })

  it('embeds attachment in the note body and reports it', async () => {
    const ctx = importContext.createImportContext('it3', new AbortController().signal)
    const summary = await importer.googleKeepImporter.run({ sourcePaths: [FIXTURE] }, ctx)

    expect(summary.attachments).toBe(1)

    const keepDir = path.join(tempVault.notesDir, 'Google Keep')
    const attachFile = path.join(keepDir, 'Note With Attachment.md')
    expect(fs.existsSync(attachFile)).toBe(true)

    const content = fs.readFileSync(attachFile, 'utf8')
    // Attachment should have been embedded with a memry-file:// reference.
    expect(content).toContain('memry-file://')
  })

  it('applies synthetic Keep/ tags to the text note', async () => {
    const ctx = importContext.createImportContext('it4', new AbortController().signal)
    await importer.googleKeepImporter.run({ sourcePaths: [FIXTURE] }, ctx)

    const keepDir = path.join(tempVault.notesDir, 'Google Keep')
    const textFile = path.join(keepDir, 'My Text Note.md')
    expect(fs.existsSync(textFile)).toBe(true)

    const content = fs.readFileSync(textFile, 'utf8')
    // My Text Note has color=BLUE, label=work, isPinned=true
    expect(content).toContain('Keep/Color/BLUE')
    expect(content).toContain('Keep/Label/work')
    expect(content).toContain('Keep/Pinned')
  })

  it('converts timestamps to the correct date string', async () => {
    const ctx = importContext.createImportContext('it5', new AbortController().signal)
    await importer.googleKeepImporter.run({ sourcePaths: [FIXTURE] }, ctx)

    // Timestamps now live on the note record, not in the file.
    const row = indexDb.sqlite
      .prepare('SELECT created_at AS createdAt FROM note_cache WHERE path = ?')
      .get('notes/Google Keep/My Text Note.md') as { createdAt: string } | undefined
    // createdTimestampUsec: 1_609_459_200_000_000 → 2021-01-01
    expect(row?.createdAt).toContain('2021-01-01')
  })

  it('skips .html files — only 3 notes, not 4', async () => {
    const ctx = importContext.createImportContext('it6', new AbortController().signal)
    const summary = await importer.googleKeepImporter.run({ sourcePaths: [FIXTURE] }, ctx)

    // The .html duplicate of My Text Note must NOT add an extra import.
    expect(summary.imported).toBe(3)
  })

  it('stops early when cancelled before scanning', async () => {
    const ac = new AbortController()
    ac.abort()
    const ctx = importContext.createImportContext('it7', ac.signal)
    const summary = await importer.googleKeepImporter.run({ sourcePaths: [FIXTURE] }, ctx)
    expect(summary.imported).toBe(0)
  })
})
