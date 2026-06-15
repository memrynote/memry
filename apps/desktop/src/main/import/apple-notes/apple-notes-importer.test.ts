/**
 * Integration test for the Apple Notes importer orchestrator.
 *
 * Approach: synthetic-sqlite. We build a minimal NoteStore.sqlite with the
 * exact tables/columns the importer queries (z_primarykey,
 * ziccloudsyncingobject, zicnotedata) and one note whose ZDATA column is
 * gzip(protobuf(document)) — encoded with the pure package's own descriptor.
 * The importer then copies + opens that DB for real, decoding through the same
 * gunzip → decode → convert path it uses in production. No real user DB ships.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import zlib from 'zlib'
import Database from 'better-sqlite3'
import { Root } from 'protobufjs'
import { descriptor, DOCUMENT_TYPE, ANStyleType, ANFontWeight } from '@memry/apple-notes-import'
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

/** Encode a note document into gzip(protobuf) bytes using the package descriptor. */
function encodeNoteData(
  text: string,
  runs: { length: number; paragraphStyle?: unknown; fontWeight?: number }[]
): Buffer {
  const Document = Root.fromJSON(descriptor).lookupType(DOCUMENT_TYPE)
  const payload = { version: 1, note: { noteText: text, attributeRun: runs } }
  const bytes = Document.encode(Document.fromObject(payload)).finish()
  return zlib.gzipSync(Buffer.from(bytes))
}

/** Build a minimal but faithful NoteStore.sqlite with one folder + one note. */
function buildSyntheticDb(dbPath: string): void {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE z_primarykey (z_ent INTEGER, z_name TEXT);
    CREATE TABLE ziccloudsyncingobject (
      z_pk INTEGER PRIMARY KEY,
      z_ent INTEGER,
      zname TEXT,
      zidentifier TEXT,
      ztitle1 TEXT,
      ztitle2 TEXT,
      zfolder INTEGER,
      zparent INTEGER,
      zfoldertype INTEGER,
      zowner INTEGER,
      zmedia INTEGER,
      zfilename TEXT,
      zgeneration1 TEXT,
      znote INTEGER,
      zcreationdate1 REAL,
      zmodificationdate1 REAL,
      zispasswordprotected INTEGER
    );
    CREATE TABLE zicnotedata (z_pk INTEGER PRIMARY KEY, znote INTEGER, zdata BLOB);
  `)

  // Entity ids
  db.prepare('INSERT INTO z_primarykey (z_ent, z_name) VALUES (?, ?)').run(1, 'ICAccount')
  db.prepare('INSERT INTO z_primarykey (z_ent, z_name) VALUES (?, ?)').run(2, 'ICFolder')
  db.prepare('INSERT INTO z_primarykey (z_ent, z_name) VALUES (?, ?)').run(3, 'ICNote')
  db.prepare('INSERT INTO z_primarykey (z_ent, z_name) VALUES (?, ?)').run(4, 'ICMedia')

  // Account (pk 10)
  db.prepare(
    'INSERT INTO ziccloudsyncingobject (z_pk, z_ent, zname, zidentifier) VALUES (?,?,?,?)'
  ).run(10, 1, 'iCloud', 'ACCT-UUID')

  // Folder "Work" (pk 20), owned by account 10
  db.prepare(
    'INSERT INTO ziccloudsyncingobject ' +
      '(z_pk, z_ent, ztitle2, zparent, zidentifier, zfoldertype, zowner) VALUES (?,?,?,?,?,?,?)'
  ).run(20, 2, 'Work', null, 'FOLDER-UUID', 0, 10)

  // Note (pk 30) in folder 20
  const created = 700000000 // CoreTime seconds
  const modified = 700100000
  db.prepare(
    'INSERT INTO ziccloudsyncingobject ' +
      '(z_pk, z_ent, ztitle1, zfolder, zcreationdate1, zmodificationdate1, zispasswordprotected) ' +
      'VALUES (?,?,?,?,?,?,?)'
  ).run(30, 3, 'My Note', 20, created, modified, 0)

  // Note body: a title, a bold word, and a checkbox.
  const text = 'My Note\nbold word\ntask\n'
  const data = encodeNoteData(text, [
    { length: 'My Note\n'.length, paragraphStyle: { styleType: ANStyleType.Title } },
    { length: 'bold '.length },
    { length: 'word'.length, fontWeight: ANFontWeight.Bold },
    { length: '\n'.length },
    {
      length: 'task\n'.length,
      paragraphStyle: { styleType: ANStyleType.Checkbox, checklist: { done: 0 } }
    }
  ])
  db.prepare('INSERT INTO zicnotedata (z_pk, znote, zdata) VALUES (?,?,?)').run(1, 30, data)

  // A second, password-protected note (pk 31) — should be skipped.
  db.prepare(
    'INSERT INTO ziccloudsyncingobject ' +
      '(z_pk, z_ent, ztitle1, zfolder, zispasswordprotected) VALUES (?,?,?,?,?)'
  ).run(31, 3, 'Secret', 20, 1)
  db.prepare('INSERT INTO zicnotedata (z_pk, znote, zdata) VALUES (?,?,?)').run(
    2,
    31,
    encodeNoteData('Secret\n', [{ length: 'Secret\n'.length }])
  )

  db.close()
}

describe('appleNotesImporter (integration, synthetic NoteStore.sqlite)', () => {
  let tempVault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult
  let dbDir: string
  let dbPath: string

  let vaultIndex: typeof import('../../vault/index')
  let database: typeof import('../../database')
  let importer: typeof import('./apple-notes-importer')
  let importContext: typeof import('../import-context')
  let platformSpy: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(async () => {
    // Force darwin so the macOS guard passes regardless of CI host.
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')

    tempVault = createTestVault('apple-notes-import-test')
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()

    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-notes-src-'))
    dbPath = path.join(dbDir, 'NoteStore.sqlite')
    buildSyntheticDb(dbPath)

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

    importer = await import('./apple-notes-importer')
    importContext = await import('../import-context')
  })

  afterEach(async () => {
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    platformSpy = null
    indexDb.close()
    dataDb.close()
    tempVault.cleanup()
    fs.rmSync(dbDir, { recursive: true, force: true })
  })

  it('imports a note into Apple Notes/<folder> with converted markdown', async () => {
    const ctx = importContext.createImportContext('an1', new AbortController().signal)
    const summary = await importer.appleNotesImporter.run({ sourcePaths: [dbPath] }, ctx)

    expect(summary.failed).toEqual([])
    expect(summary.imported).toBe(1)
    // The password-protected note is skipped, not failed.
    expect(summary.skipped).toBeGreaterThanOrEqual(1)

    const notePath = path.join(tempVault.notesDir, 'Apple Notes', 'Work', 'My Note.md')
    expect(fs.existsSync(notePath)).toBe(true)

    const md = fs.readFileSync(notePath, 'utf8')
    expect(md).toContain('# My Note')
    expect(md).toContain('**word**')
    expect(md).toContain('- [ ] task')
  })

  it('preserves Apple Notes CoreTime created timestamp', async () => {
    const ctx = importContext.createImportContext('an2', new AbortController().signal)
    await importer.appleNotesImporter.run({ sourcePaths: [dbPath] }, ctx)

    const md = fs.readFileSync(
      path.join(tempVault.notesDir, 'Apple Notes', 'Work', 'My Note.md'),
      'utf8'
    )
    // created = 700000000 CoreTime → 2023 (see coreTimeToIso).
    expect(md).toContain('2023-03-08')
  })

  it('stops early when cancelled', async () => {
    const ac = new AbortController()
    ac.abort()
    const ctx = importContext.createImportContext('an3', ac.signal)
    const summary = await importer.appleNotesImporter.run({ sourcePaths: [dbPath] }, ctx)
    expect(summary.imported).toBe(0)
  })

  it('fails fast off macOS', async () => {
    platformSpy?.mockReturnValue('win32')
    const ctx = importContext.createImportContext('an4', new AbortController().signal)
    const summary = await importer.appleNotesImporter.run({ sourcePaths: [dbPath] }, ctx)
    expect(summary.imported).toBe(0)
    expect(summary.failed.length).toBe(1)
  })
})
