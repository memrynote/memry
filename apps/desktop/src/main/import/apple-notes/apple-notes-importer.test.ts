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
import { descriptor, DOCUMENT_TYPE, ANStyleType, ANFontWeight } from '@memry/importers/apple-notes'
import { scanAppleNotesFolders } from './note-store'
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

/** Encode a note document into gzip(protobuf) bytes using the package descriptor. */
function encodeNoteData(
  text: string,
  runs: {
    length: number
    paragraphStyle?: unknown
    fontWeight?: number
    attachmentInfo?: { attachmentIdentifier: string; typeUti: string }
  }[]
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
    CREATE TABLE z_primarykey (Z_ENT INTEGER, Z_NAME TEXT);
    CREATE TABLE ziccloudsyncingobject (
      z_pk INTEGER PRIMARY KEY,
      z_ent INTEGER,
      zname TEXT,
      zidentifier TEXT,
      ztitle TEXT,
      ztitle1 TEXT,
      ztitle2 TEXT,
      zfolder INTEGER,
      zparent INTEGER,
      zfoldertype INTEGER,
      zowner INTEGER,
      zmedia INTEGER,
      zfilename TEXT,
      zgeneration1 TEXT,
      ztypeuti TEXT,
      zurlstring TEXT,
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

const OBJ = '￼' // object-replacement char Apple Notes uses for inline attachments

/**
 * Build a NoteStore.sqlite with two notes carrying real-format attachments:
 *  - a file/image attachment (ICAttachment.ZMEDIA → ICMedia holding the filename)
 *  - a `public.url` link card (ICAttachment.ZTYPEUTI/ZTITLE/ZURLSTRING, no media)
 * Mirrors the live schema: the protobuf references the ICAttachment identifier,
 * and the on-disk filename lives one hop away on the ICMedia row.
 */
function buildAttachmentDb(dbPath: string): void {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE z_primarykey (Z_ENT INTEGER, Z_NAME TEXT);
    CREATE TABLE ziccloudsyncingobject (
      z_pk INTEGER PRIMARY KEY,
      z_ent INTEGER,
      zname TEXT,
      zidentifier TEXT,
      ztitle TEXT,
      ztitle1 TEXT,
      ztitle2 TEXT,
      zfolder INTEGER,
      zparent INTEGER,
      zfoldertype INTEGER,
      zowner INTEGER,
      zmedia INTEGER,
      zfilename TEXT,
      zgeneration1 TEXT,
      ztypeuti TEXT,
      zurlstring TEXT,
      znote INTEGER,
      zcreationdate1 REAL,
      zmodificationdate1 REAL,
      zispasswordprotected INTEGER
    );
    CREATE TABLE zicnotedata (z_pk INTEGER PRIMARY KEY, znote INTEGER, zdata BLOB);
  `)

  db.prepare('INSERT INTO z_primarykey (z_ent, z_name) VALUES (?, ?)').run(1, 'ICAccount')
  db.prepare('INSERT INTO z_primarykey (z_ent, z_name) VALUES (?, ?)').run(2, 'ICFolder')
  db.prepare('INSERT INTO z_primarykey (z_ent, z_name) VALUES (?, ?)').run(3, 'ICNote')
  db.prepare('INSERT INTO z_primarykey (z_ent, z_name) VALUES (?, ?)').run(4, 'ICMedia')
  db.prepare('INSERT INTO z_primarykey (z_ent, z_name) VALUES (?, ?)').run(5, 'ICAttachment')

  db.prepare(
    'INSERT INTO ziccloudsyncingobject (z_pk, z_ent, zname, zidentifier) VALUES (?,?,?,?)'
  ).run(10, 1, 'iCloud', 'ACCT-UUID')
  db.prepare(
    'INSERT INTO ziccloudsyncingobject ' +
      '(z_pk, z_ent, ztitle2, zparent, zidentifier, zfoldertype, zowner) VALUES (?,?,?,?,?,?,?)'
  ).run(20, 2, 'Work', null, 'FOLDER-UUID', 0, 10)

  // Note 50: one inline image attachment (token = ICAttachment id 'ATT-IMG').
  db.prepare(
    'INSERT INTO ziccloudsyncingobject ' +
      '(z_pk, z_ent, ztitle1, zfolder, zispasswordprotected) VALUES (?,?,?,?,?)'
  ).run(50, 3, 'Photo Note', 20, 0)
  db.prepare('INSERT INTO zicnotedata (z_pk, znote, zdata) VALUES (?,?,?)').run(
    1,
    50,
    encodeNoteData(`Photo Note\n${OBJ}`, [
      { length: 'Photo Note\n'.length, paragraphStyle: { styleType: ANStyleType.Title } },
      { length: 1, attachmentInfo: { attachmentIdentifier: 'ATT-IMG', typeUti: 'public.png' } }
    ])
  )
  // ICMedia row holding the real filename/generation, ICAttachment pointing at it.
  db.prepare(
    'INSERT INTO ziccloudsyncingobject ' +
      '(z_pk, z_ent, zidentifier, zfilename, zgeneration1) VALUES (?,?,?,?,?)'
  ).run(41, 4, 'MEDIA-IMG', 'Pasted Graphic.png', 'GEN')
  db.prepare(
    'INSERT INTO ziccloudsyncingobject ' +
      '(z_pk, z_ent, zidentifier, ztypeuti, zmedia, znote) VALUES (?,?,?,?,?,?)'
  ).run(60, 5, 'ATT-IMG', 'public.png', 41, 50)

  // Note 51: one public.url link card (token = ICAttachment id 'ATT-URL').
  db.prepare(
    'INSERT INTO ziccloudsyncingobject ' +
      '(z_pk, z_ent, ztitle1, zfolder, zispasswordprotected) VALUES (?,?,?,?,?)'
  ).run(51, 3, 'Link Note', 20, 0)
  db.prepare('INSERT INTO zicnotedata (z_pk, znote, zdata) VALUES (?,?,?)').run(
    2,
    51,
    encodeNoteData(`Link Note\n${OBJ}`, [
      { length: 'Link Note\n'.length, paragraphStyle: { styleType: ANStyleType.Title } },
      { length: 1, attachmentInfo: { attachmentIdentifier: 'ATT-URL', typeUti: 'public.url' } }
    ])
  )
  db.prepare(
    'INSERT INTO ziccloudsyncingobject ' +
      '(z_pk, z_ent, zidentifier, ztypeuti, ztitle, zurlstring, znote) VALUES (?,?,?,?,?,?,?)'
  ).run(61, 5, 'ATT-URL', 'public.url', 'Foursquare', 'https://example.com/x', 51)

  // Note 52: one non-image file attachment (xlsx) → renders as a file block.
  db.prepare(
    'INSERT INTO ziccloudsyncingobject ' +
      '(z_pk, z_ent, ztitle1, zfolder, zispasswordprotected) VALUES (?,?,?,?,?)'
  ).run(52, 3, 'Doc Note', 20, 0)
  db.prepare('INSERT INTO zicnotedata (z_pk, znote, zdata) VALUES (?,?,?)').run(
    3,
    52,
    encodeNoteData(`Doc Note\n${OBJ}`, [
      { length: 'Doc Note\n'.length, paragraphStyle: { styleType: ANStyleType.Title } },
      {
        length: 1,
        attachmentInfo: {
          attachmentIdentifier: 'ATT-DOC',
          typeUti: 'org.openxmlformats.spreadsheetml.sheet'
        }
      }
    ])
  )
  db.prepare(
    'INSERT INTO ziccloudsyncingobject ' +
      '(z_pk, z_ent, zidentifier, zfilename, zgeneration1) VALUES (?,?,?,?,?)'
  ).run(42, 4, 'MEDIA-DOC', 'sheet.xlsx', 'GEN2')
  db.prepare(
    'INSERT INTO ziccloudsyncingobject ' +
      '(z_pk, z_ent, zidentifier, ztypeuti, zmedia, znote) VALUES (?,?,?,?,?,?)'
  ).run(62, 5, 'ATT-DOC', 'org.openxmlformats.spreadsheetml.sheet', 42, 52)

  db.close()
}

/** Longer than the importer's MAX_FOLDER_DEPTH so the cap is exercised. */
const DEEP_CHAIN_LENGTH = 40
const MAX_FOLDER_DEPTH = 32

/**
 * Build a NoteStore.sqlite exercising the ZPARENT walk and the folder picker:
 * a nested chain, two same-named leaves under different parents, a
 * default-named leaf under a real parent, a parent cycle, a chain deeper than
 * the walk's cap, a smart folder, a trash folder, and a note filed nowhere.
 */
function buildNestedFolderDb(dbPath: string): void {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE z_primarykey (Z_ENT INTEGER, Z_NAME TEXT);
    CREATE TABLE ziccloudsyncingobject (
      z_pk INTEGER PRIMARY KEY,
      z_ent INTEGER,
      zname TEXT,
      zidentifier TEXT,
      ztitle TEXT,
      ztitle1 TEXT,
      ztitle2 TEXT,
      zfolder INTEGER,
      zparent INTEGER,
      zfoldertype INTEGER,
      zowner INTEGER,
      zmedia INTEGER,
      zfilename TEXT,
      zgeneration1 TEXT,
      ztypeuti TEXT,
      zurlstring TEXT,
      znote INTEGER,
      zcreationdate1 REAL,
      zmodificationdate1 REAL,
      zispasswordprotected INTEGER
    );
    CREATE TABLE zicnotedata (z_pk INTEGER PRIMARY KEY, znote INTEGER, zdata BLOB);
  `)
  db.prepare('INSERT INTO z_primarykey (z_ent, z_name) VALUES (?, ?)').run(1, 'ICAccount')
  db.prepare('INSERT INTO z_primarykey (z_ent, z_name) VALUES (?, ?)').run(2, 'ICFolder')
  db.prepare('INSERT INTO z_primarykey (z_ent, z_name) VALUES (?, ?)').run(3, 'ICNote')
  db.prepare('INSERT INTO z_primarykey (z_ent, z_name) VALUES (?, ?)').run(4, 'ICMedia')
  db.prepare(
    'INSERT INTO ziccloudsyncingobject (z_pk, z_ent, zname, zidentifier) VALUES (?,?,?,?)'
  ).run(10, 1, 'iCloud', 'ACCT-UUID')

  const insertFolder = db.prepare(
    'INSERT INTO ziccloudsyncingobject ' +
      '(z_pk, z_ent, ztitle2, zparent, zidentifier, zfoldertype, zowner) VALUES (?,?,?,?,?,?,?)'
  )
  const folder = (pk: number, title: string, parent: number | null, identifier?: string): void => {
    insertFolder.run(pk, 2, title, parent, identifier ?? `FOLDER-${pk}`, 0, 10)
  }
  folder(20, 'Work', null)
  folder(21, 'Clients', 20)
  folder(22, 'Acme', 21)
  folder(23, 'Personal', null)
  folder(24, 'Acme', 23)
  folder(25, 'Notes', 20, 'DefaultFolder-XYZ')
  // Corrupt ZPARENT cycle: each folder claims the other as its parent.
  folder(26, 'Loop A', 27)
  folder(27, 'Loop B', 26)
  // Smart folders are saved queries, Trash is not importable — neither belongs
  // in the picker. `Archive` is a real folder that happens to sit under Trash.
  insertFolder.run(28, 2, 'Recently Deleted', null, 'TrashFolder', 1, 10)
  folder(29, 'Archive', 28)
  insertFolder.run(30, 2, 'Smart', null, 'FOLDER-30', 3, 10)
  for (let i = 0; i < DEEP_CHAIN_LENGTH; i++) {
    folder(100 + i, `D${i}`, i === 0 ? null : 100 + i - 1)
  }

  const insertNote = db.prepare(
    'INSERT INTO ziccloudsyncingobject ' +
      '(z_pk, z_ent, ztitle1, zfolder, zispasswordprotected) VALUES (?,?,?,?,?)'
  )
  const insertData = db.prepare('INSERT INTO zicnotedata (z_pk, znote, zdata) VALUES (?,?,?)')
  const note = (pk: number, title: string, folderPk: number): void => {
    insertNote.run(pk, 3, title, folderPk, 0)
    insertData.run(pk, pk, encodeNoteData(`${title}\n`, [{ length: title.length + 1 }]))
  }
  note(200, 'Work Acme Note', 22)
  note(201, 'Personal Acme Note', 24)
  note(202, 'Default Leaf Note', 25)
  note(203, 'Cycle Note', 26)
  note(204, 'Deep Note', 100 + DEEP_CHAIN_LENGTH - 1)
  note(205, 'Trash Child Note', 29)
  note(206, 'Smart Note', 30)
  note(207, 'Deleted Note', 28)
  // A note filed in no folder at all.
  insertNote.run(208, 3, 'Unfiled Note', null, 0)
  insertData.run(208, 208, encodeNoteData('Unfiled Note\n', [{ length: 13 }]))

  db.close()
}

/** Run `body` against a throwaway nested-folder NoteStore.sqlite. */
async function withNestedDb(body: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-notes-nested-'))
  const dbPath = path.join(dir, 'NoteStore.sqlite')
  buildNestedFolderDb(dbPath)
  try {
    await body(dbPath)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Write on-disk bytes for an ICMedia row under the importer's media base. */
function writeMedia(baseDir: string, mediaId: string, gen: string, filename: string): Buffer {
  const dir = path.join(baseDir, 'Accounts', 'ACCT-UUID', 'Media', mediaId, gen)
  fs.mkdirSync(dir, { recursive: true })
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  fs.writeFileSync(path.join(dir, filename), bytes)
  return bytes
}

/** Write the image + doc media files both attachment tests rely on. */
function writeAttachmentMedia(baseDir: string): Buffer {
  const png = writeMedia(baseDir, 'MEDIA-IMG', 'GEN', 'Pasted Graphic.png')
  writeMedia(baseDir, 'MEDIA-DOC', 'GEN2', 'sheet.xlsx')
  return png
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

    const notePath = path.join(tempVault.path, 'Apple Notes', 'Work', 'My Note.md')
    expect(fs.existsSync(notePath)).toBe(true)

    const md = fs.readFileSync(notePath, 'utf8')
    expect(md).toContain('# My Note')
    expect(md).toContain('**word**')
    expect(md).toContain('- [ ] task')
  })

  it('preserves Apple Notes CoreTime created timestamp', async () => {
    const ctx = importContext.createImportContext('an2', new AbortController().signal)
    await importer.appleNotesImporter.run({ sourcePaths: [dbPath] }, ctx)

    // Timestamps now live on the note record, not in the file.
    const row = indexDb.sqlite
      .prepare('SELECT created_at AS createdAt FROM note_cache WHERE path = ?')
      .get('Apple Notes/Work/My Note.md') as { createdAt: string } | undefined
    // created = 700000000 CoreTime → 2023 (see coreTimeToIso).
    expect(row?.createdAt).toContain('2023-03-08')
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

  it('requests a directory pick defaulting to the Apple Notes container', () => {
    const spec = importer.appleNotesImporter.fileSpec
    expect(spec.directory).toBe(true)
    expect(spec.defaultPath?.endsWith('Library/Group Containers/group.com.apple.notes')).toBe(true)
  })

  it('imports when given the container folder (directory selection)', async () => {
    // The user selects the folder, not the .sqlite file — the importer resolves
    // NoteStore.sqlite (and the media base) from the directory.
    const ctx = importContext.createImportContext('an-dir', new AbortController().signal)
    const summary = await importer.appleNotesImporter.run({ sourcePaths: [dbDir] }, ctx)
    expect(summary.imported).toBe(1)
    expect(fs.existsSync(path.join(tempVault.path, 'Apple Notes', 'Work', 'My Note.md'))).toBe(true)
  })

  it('reads the default NoteStore.sqlite path when no file is chosen', async () => {
    // os.homedir() honours $HOME on POSIX — point it at a fake home holding the
    // synthetic DB at the canonical Apple Notes location, then run with no paths.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-notes-home-'))
    const notesDir = path.join(fakeHome, 'Library/Group Containers/group.com.apple.notes')
    fs.mkdirSync(notesDir, { recursive: true })
    buildSyntheticDb(path.join(notesDir, 'NoteStore.sqlite'))

    const origHome = process.env.HOME
    process.env.HOME = fakeHome
    try {
      const ctx = importContext.createImportContext('an5', new AbortController().signal)
      const summary = await importer.appleNotesImporter.run({ sourcePaths: [] }, ctx)
      expect(summary.imported).toBe(1)
      expect(fs.existsSync(path.join(tempVault.path, 'Apple Notes', 'Work', 'My Note.md'))).toBe(
        true
      )
    } finally {
      if (origHome === undefined) delete process.env.HOME
      else process.env.HOME = origHome
      fs.rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  it('embeds an image attachment with the final body in one createNote (no failed token rewrite)', async () => {
    const attDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-notes-att-'))
    const attDbPath = path.join(attDir, 'NoteStore.sqlite')
    buildAttachmentDb(attDbPath)
    const bytes = writeAttachmentMedia(attDir)
    try {
      const ctx = importContext.createImportContext('an-img', new AbortController().signal)
      const summary = await importer.appleNotesImporter.run({ sourcePaths: [attDbPath] }, ctx)

      // The note is written once with the resolved body — nothing failed.
      expect(summary.failed).toEqual([])

      const notePath = path.join(tempVault.path, 'Apple Notes', 'Work', 'Photo Note.md')
      const md = fs.readFileSync(notePath, 'utf8')
      // Token resolved → no leftover placeholder; embedded image carries the
      // original filename as alt text and points at a saved vault file whose name
      // has no spaces/parens, so markdown parsing can't truncate the URL.
      expect(md).not.toContain('apple-notes-attachment:')
      expect(md).toMatch(/!\[Pasted Graphic\.png\]\(memry-file:\/\/.*Pasted-Graphic\.png\)/)
      // No literal space inside the image URL.
      expect(md).not.toMatch(/!\[[^\]]*\]\(memry-file:\/\/[^)]* [^)]*\)/)

      // The bytes landed under <vault>/attachments/<noteId>/...
      const attachmentsRoot = path.join(tempVault.path, 'attachments')
      const saved: string[] = []
      for (const noteDir of fs.readdirSync(attachmentsRoot)) {
        const full = path.join(attachmentsRoot, noteDir)
        if (!fs.statSync(full).isDirectory()) continue
        for (const f of fs.readdirSync(full))
          if (f.endsWith('Pasted-Graphic.png')) saved.push(path.join(full, f))
      }
      expect(saved.length).toBe(1)
      expect(fs.readFileSync(saved[0])).toEqual(bytes)
    } finally {
      fs.rmSync(attDir, { recursive: true, force: true })
    }
  })

  it('renders a non-image file attachment as a clickable file block, not a broken image', async () => {
    const attDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-notes-doc-'))
    const attDbPath = path.join(attDir, 'NoteStore.sqlite')
    buildAttachmentDb(attDbPath)
    writeAttachmentMedia(attDir)
    try {
      const ctx = importContext.createImportContext('an-doc', new AbortController().signal)
      await importer.appleNotesImporter.run({ sourcePaths: [attDbPath] }, ctx)

      const notePath = path.join(tempVault.path, 'Apple Notes', 'Work', 'Doc Note.md')
      const md = fs.readFileSync(notePath, 'utf8')
      expect(md).not.toContain('apple-notes-attachment:')
      // A spreadsheet is a file block (clickable), never an `![]()` image embed.
      expect(md).not.toMatch(/!\[\]\(memry-file:\/\/.*sheet\.xlsx\)/)
      expect(md).toMatch(/<!-- file:\{.*sheet\.xlsx.*\} -->/)
      expect(md).toContain('memry-file://')
    } finally {
      fs.rmSync(attDir, { recursive: true, force: true })
    }
  })

  it('converts a public.url attachment into a markdown link, not a skip', async () => {
    const attDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-notes-url-'))
    const attDbPath = path.join(attDir, 'NoteStore.sqlite')
    buildAttachmentDb(attDbPath)
    writeAttachmentMedia(attDir)
    try {
      const ctx = importContext.createImportContext('an-url', new AbortController().signal)
      const summary = await importer.appleNotesImporter.run({ sourcePaths: [attDbPath] }, ctx)

      const notePath = path.join(tempVault.path, 'Apple Notes', 'Work', 'Link Note.md')
      const md = fs.readFileSync(notePath, 'utf8')
      expect(md).toContain('[Foursquare](https://example.com/x)')
      expect(md).not.toContain('apple-notes-attachment:')
      // A resolved URL card is a link, never an image embed or a skip.
      expect(md).not.toContain('![](https://example.com/x)')
      expect(summary.skipped).toBe(0)
      // Both file/image attachments were saved.
      expect(summary.attachments).toBe(2)
    } finally {
      fs.rmSync(attDir, { recursive: true, force: true })
    }
  })

  it('resolves the full folder chain, keeping same-named leaves apart', async () => {
    await withNestedDb(async (nestedDbPath) => {
      const ctx = importContext.createImportContext('an-nested', new AbortController().signal)
      const summary = await importer.appleNotesImporter.run({ sourcePaths: [nestedDbPath] }, ctx)
      expect(summary.failed).toEqual([])
      // Every note except the one sitting directly in Trash.
      expect(summary.imported).toBe(8)

      const at = (...segments: string[]): boolean =>
        fs.existsSync(path.join(tempVault.path, 'Apple Notes', ...segments))

      // Nested chain preserved; the two "Acme" folders no longer merge.
      expect(at('Work', 'Clients', 'Acme', 'Work Acme Note.md')).toBe(true)
      expect(at('Personal', 'Acme', 'Personal Acme Note.md')).toBe(true)
      // Default-folder suppression hits the leaf only — "Work" survives.
      expect(at('Work', 'Default Leaf Note.md')).toBe(true)
      // A ZPARENT cycle terminates instead of looping forever.
      expect(at('Loop B', 'Loop A', 'Cycle Note.md')).toBe(true)
      // The trash root is not a real folder — no literal trash tree in the vault.
      expect(at('Archive', 'Trash Child Note.md')).toBe(true)
      expect(at('Recently Deleted')).toBe(false)
      // Deeper than the cap → the deepest MAX_FOLDER_DEPTH segments are kept.
      const deepest = Array.from(
        { length: MAX_FOLDER_DEPTH },
        (_, i) => `D${DEEP_CHAIN_LENGTH - MAX_FOLDER_DEPTH + i}`
      )
      expect(at(...deepest, 'Deep Note.md')).toBe(true)
      // Trash stays in Trash.
      expect(at('Recently Deleted', 'Deleted Note.md')).toBe(false)
    })
  })

  it('scans the folder tree with nesting, counts and no smart/trash folders', async () => {
    await withNestedDb(async (nestedDbPath) => {
      const tree = await scanAppleNotesFolders(nestedDbPath)

      expect(tree.accounts.length).toBe(1)
      const account = tree.accounts[0]
      expect(account.name).toBe('iCloud')

      const titles = account.folders.map((f) => f.title)
      expect(titles).toContain('Work')
      expect(titles).toContain('Personal')
      // Saved queries and Trash are not importable containers.
      expect(titles).not.toContain('Smart')
      expect(titles).not.toContain('Recently Deleted')

      const work = account.folders.find((f) => f.title === 'Work')
      const clients = work?.children.find((f) => f.title === 'Clients')
      const acme = clients?.children.find((f) => f.title === 'Acme')
      expect(acme?.id).toBe('FOLDER-22')
      expect(acme?.noteCount).toBe(1)
      // Work holds no notes itself but two live below it (Acme + its "Notes" leaf).
      expect(work?.noteCount).toBe(0)
      expect(work?.totalNoteCount).toBe(2)

      // A ZPARENT cycle surfaces at the top level instead of vanishing.
      const loop = account.folders.find((f) => f.title.startsWith('Loop'))
      expect(loop).toBeDefined()
      expect(loop?.totalNoteCount).toBe(1)

      expect(tree.unfiledNoteCount).toBe(1)
    })
  })

  it('imports only the picked folders, and everything when the selection is empty', async () => {
    await withNestedDb(async (nestedDbPath) => {
      const at = (...segments: string[]): boolean =>
        fs.existsSync(path.join(tempVault.path, 'Apple Notes', ...segments))

      const picked = importContext.createImportContext('an-pick', new AbortController().signal)
      const pickedSummary = await importer.appleNotesImporter.run(
        { sourcePaths: [nestedDbPath], options: { folderIds: ['FOLDER-22'] } },
        picked
      )
      expect(pickedSummary.imported).toBe(1)
      expect(at('Work', 'Clients', 'Acme', 'Work Acme Note.md')).toBe(true)
      expect(at('Personal', 'Acme', 'Personal Acme Note.md')).toBe(false)

      // Unfiled notes are their own row in the picker, selectable on their own.
      const unfiled = importContext.createImportContext('an-unfiled', new AbortController().signal)
      const unfiledSummary = await importer.appleNotesImporter.run(
        { sourcePaths: [nestedDbPath], options: { folderIds: [], includeUnfiledNotes: true } },
        unfiled
      )
      expect(unfiledSummary.imported).toBe(1)
      expect(at('Unfiled Note.md')).toBe(true)

      // Empty options (older caller, or a failed folder scan) → import everything.
      const all = importContext.createImportContext('an-all', new AbortController().signal)
      const allSummary = await importer.appleNotesImporter.run(
        { sourcePaths: [nestedDbPath], options: {} },
        all
      )
      expect(allSummary.imported).toBe(8)
    })
  })

  it('maps a permission-denied database to a Full Disk Access error', async () => {
    // chmod 000 makes the source unreadable even to its owner → EACCES on copy,
    // the same denial macOS TCC produces for the protected Notes container.
    const locked = path.join(dbDir, 'Locked.sqlite')
    fs.writeFileSync(locked, 'not a real db')
    fs.chmodSync(locked, 0o000)
    try {
      const ctx = importContext.createImportContext('an6', new AbortController().signal)
      await expect(importer.appleNotesImporter.run({ sourcePaths: [locked] }, ctx)).rejects.toThrow(
        /Full Disk Access/
      )
    } finally {
      fs.chmodSync(locked, 0o600)
    }
  })
})
