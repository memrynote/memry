/**
 * Integration test for the Bear importer orchestrator.
 * Builds a synthetic .bear2bk fixture at runtime and runs against a real temp vault.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execSync } from 'child_process'
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

const NOTE_A_UID = 'BEAR-UID-NOTE-A-001'
const NOTE_B_UID = 'BEAR-UID-NOTE-B-002'

let FIXTURE: string
let tmpDir: string

beforeAll(() => {
  // Build a synthetic .bear2bk fixture in a temp directory
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bear-fixture-'))
  const fixturePath = path.join(tmpDir, 'test.bear2bk')

  // Real Bear exports wrap every textbundle inside a single backup folder.
  const rootName = 'Bear Notes Backup'
  const rootDir = path.join(tmpDir, rootName)
  const noteADir = path.join(rootDir, 'NoteA.textbundle')
  const noteAAssetsDir = path.join(noteADir, 'assets')
  const noteBDir = path.join(rootDir, 'NoteB-archived.textbundle')

  fs.mkdirSync(noteAAssetsDir, { recursive: true })
  fs.mkdirSync(noteBDir, { recursive: true })

  // Note A: references Note B via bear link, has enclosed tag, references an
  // asset whose markdown ref is URL-encoded (spaces → %20) like real Bear.
  fs.writeFileSync(
    path.join(noteADir, 'text.md'),
    [
      '# Note A',
      '',
      '#[my tag]#',
      '',
      `See also [Note B](bear://x-callback-url/open-note?id=${NOTE_B_UID})`,
      '',
      '![shared image](assets/shared%20image.png)'
    ].join('\n'),
    'utf8'
  )

  fs.writeFileSync(
    path.join(noteADir, 'info.json'),
    JSON.stringify({
      creatorIdentifier: 'net.shinyfrog.bear',
      'net.shinyfrog.bear': {
        uniqueIdentifier: NOTE_A_UID,
        creationDate: '2024-01-01T10:00:00.000Z',
        modificationDate: '2024-06-01T12:00:00.000Z',
        archived: 0,
        trashed: 0
      }
    }),
    'utf8'
  )

  // Asset file (real decoded filename has spaces)
  fs.writeFileSync(
    path.join(noteAAssetsDir, 'shared image.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47])
  )

  // Note B: archived
  fs.writeFileSync(
    path.join(noteBDir, 'text.md'),
    ['# Note B', '', 'This note is archived.'].join('\n'),
    'utf8'
  )

  fs.writeFileSync(
    path.join(noteBDir, 'info.json'),
    JSON.stringify({
      creatorIdentifier: 'net.shinyfrog.bear',
      'net.shinyfrog.bear': {
        uniqueIdentifier: NOTE_B_UID,
        archived: 1,
        trashed: 0
      }
    }),
    'utf8'
  )

  // Zip the wrapping backup folder into the fixture
  execSync(`cd "${tmpDir}" && zip -r "${fixturePath}" "${rootName}"`)
  FIXTURE = fixturePath
})

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore cleanup errors
  }
})

describe('bearImporter (integration)', () => {
  let tempVault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  let vaultIndex: typeof import('../../vault/index')
  let database: typeof import('../../database')
  let importer: typeof import('./bear-importer')
  let importContext: typeof import('../import-context')

  beforeEach(async () => {
    tempVault = createTestVault('bear-import-test')
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

    importer = await import('./bear-importer')
    importContext = await import('../import-context')
  })

  afterEach(async () => {
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    tempVault.cleanup()
  })

  it('imports bear export: rewrites bear links, extracts tags, saves attachments', async () => {
    const ctx = importContext.createImportContext('bear-it1', new AbortController().signal)
    const summary = await importer.bearImporter.run({ sourcePaths: [FIXTURE] }, ctx)

    expect(summary.failed).toEqual([])
    expect(summary.imported).toBe(2)
    expect(summary.attachments).toBe(1)

    // Note A should exist under Bear/
    const bearDir = path.join(tempVault.notesDir, 'Bear')
    const noteAFile = path.join(bearDir, 'Note A.md')
    expect(fs.existsSync(noteAFile)).toBe(true)

    const noteAContent = fs.readFileSync(noteAFile, 'utf8')
    // bear:// link rewritten to wiki-link
    expect(noteAContent).toContain('[[Note B]]')
    // attachment link rewritten to memry-file://
    expect(noteAContent).toContain('memry-file://')
    // image embed keeps its alt text and the saved filename has no spaces, so the
    // markdown image link URL can't be truncated by a space
    const imageMatch = noteAContent.match(/!\[shared image\]\((memry-file:\/\/[^)]+)\)/)
    expect(imageMatch).not.toBeNull()
    expect(imageMatch![1]).not.toContain(' ')
    expect(imageMatch![1]).toContain('shared-image.png')
    // no leftover unresolved asset ref
    expect(noteAContent).not.toContain('assets/shared%20image.png')

    // Note B is archived → Bear/Archived/
    const archivedDir = path.join(tempVault.notesDir, 'Bear', 'Archived')
    const noteBFile = path.join(archivedDir, 'Note B.md')
    expect(fs.existsSync(noteBFile)).toBe(true)
  })

  it('extracts #[my tag]# as my_tag in note frontmatter', async () => {
    const ctx = importContext.createImportContext('bear-it2', new AbortController().signal)
    await importer.bearImporter.run({ sourcePaths: [FIXTURE] }, ctx)

    const bearDir = path.join(tempVault.notesDir, 'Bear')
    const noteAFile = path.join(bearDir, 'Note A.md')
    const content = fs.readFileSync(noteAFile, 'utf8')
    expect(content).toContain('my_tag')
  })

  it('places archived note under Bear/Archived', async () => {
    const ctx = importContext.createImportContext('bear-it3', new AbortController().signal)
    const summary = await importer.bearImporter.run({ sourcePaths: [FIXTURE] }, ctx)

    expect(summary.failed).toEqual([])

    const archivedDir = path.join(tempVault.notesDir, 'Bear', 'Archived')
    const noteBFile = path.join(archivedDir, 'Note B.md')
    expect(fs.existsSync(noteBFile)).toBe(true)
  })

  it('stops early when cancelled', async () => {
    const ac = new AbortController()
    ac.abort()
    const ctx = importContext.createImportContext('bear-it4', ac.signal)
    const summary = await importer.bearImporter.run({ sourcePaths: [FIXTURE] }, ctx)
    expect(summary.imported).toBe(0)
  })
})
