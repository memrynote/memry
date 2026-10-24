/**
 * Locked Apple Notes: the importer decrypts them with the user's Notes
 * password, and the dialog's password check and folder scan report on them.
 * Same synthetic-NoteStore approach as apple-notes-importer.test.ts, with the
 * crypto columns the real schema carries and bodies locked via the fixture.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import crypto from 'crypto'
import * as os from 'os'
import * as path from 'path'
import zlib from 'zlib'
import Database from 'better-sqlite3'
import { Root } from 'protobufjs'
import { descriptor, DOCUMENT_TYPE } from '@memry/importers/apple-notes'
import { IMPORT_MESSAGE_CODES } from '@memry/importers/messages'
import { lockNote, lockNoteEnvelope } from './locked-note-fixture'
import { scanAppleNotesFolders } from './note-store'
import { checkNotesUnlock } from './locked-notes'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { VaultStatus, VaultConfig } from '@memry/contracts/vault-api'
import { startProjectionRuntime, stopProjectionRuntime } from '../../projections'
import { createNoteDerivedStateProjector } from '../../projections/projectors/note-derived-state-projector'
import type * as AppleNotesImporterModule from './apple-notes-importer'
import type * as ImportContextModule from '../import-context'

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

const OBJ = '￼'
const PASSWORD = 'correct horse'

function encodeNoteData(
  text: string,
  runs: { length: number; attachmentInfo?: { attachmentIdentifier: string; typeUti: string } }[]
): Buffer {
  const Document = Root.fromJSON(descriptor).lookupType(DOCUMENT_TYPE)
  const payload = { version: 1, note: { noteText: text, attributeRun: runs } }
  return zlib.gzipSync(Buffer.from(Document.encode(Document.fromObject(payload)).finish()))
}

const plainBody = (title: string): Buffer =>
  encodeNoteData(`${title}\nbody of ${title}\n`, [
    { length: `${title}\nbody of ${title}\n`.length }
  ])

/**
 * One account/folder and four notes: open, locked with PASSWORD, locked with
 * another password, and locked with PASSWORD plus an inline image attachment.
 */
function buildLockedDb(dbPath: string): void {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE z_primarykey (Z_ENT INTEGER, Z_NAME TEXT);
    CREATE TABLE ziccloudsyncingobject (
      z_pk INTEGER PRIMARY KEY, z_ent INTEGER, zname TEXT, zidentifier TEXT, ztitle1 TEXT,
      ztitle2 TEXT, zfolder INTEGER, zparent INTEGER, zfoldertype INTEGER, zowner INTEGER,
      zmedia INTEGER, ztypeuti TEXT, ztitle TEXT, zurlstring TEXT, zfilename TEXT,
      zgeneration1 TEXT, zcreationdate1 REAL, zmodificationdate1 REAL,
      zispasswordprotected INTEGER, zcryptosalt BLOB, zcryptoiterationcount INTEGER,
      zcryptowrappedkey BLOB
    );
    CREATE TABLE zicnotedata (
      z_pk INTEGER PRIMARY KEY, znote INTEGER, zdata BLOB,
      zcryptoinitializationvector BLOB, zcryptotag BLOB
    );
  `)
  const key = db.prepare('INSERT INTO z_primarykey (z_ent, z_name) VALUES (?, ?)')
  key.run(1, 'ICAccount')
  key.run(2, 'ICFolder')
  key.run(3, 'ICNote')
  key.run(4, 'ICMedia')
  db.prepare(
    'INSERT INTO ziccloudsyncingobject (z_pk, z_ent, zname, zidentifier) VALUES (?,?,?,?)'
  ).run(10, 1, 'iCloud', 'ACCT')
  db.prepare(
    'INSERT INTO ziccloudsyncingobject (z_pk, z_ent, ztitle2, zidentifier, zfoldertype, zowner) VALUES (?,?,?,?,?,?)'
  ).run(20, 2, 'Work', 'FOLDER', 0, 10)

  const insertNote = db.prepare(
    'INSERT INTO ziccloudsyncingobject (z_pk, z_ent, ztitle1, zfolder, zispasswordprotected, ' +
      'zcryptosalt, zcryptoiterationcount, zcryptowrappedkey) VALUES (?,?,?,?,?,?,?,?)'
  )
  const insertData = db.prepare(
    'INSERT INTO zicnotedata (znote, zdata, zcryptoinitializationvector, zcryptotag) VALUES (?,?,?,?)'
  )

  insertNote.run(30, 3, 'Open Note', 20, 0, null, null, null)
  insertData.run(30, plainBody('Open Note'), null, null)

  const addLocked = (pk: number, title: string, password: string, body: Buffer): void => {
    const { note, data } = lockNote(password, body)
    insertNote.run(pk, 3, title, 20, 1, note.salt, note.iterations, note.wrappedKey)
    insertData.run(pk, data, note.iv, note.tag)
  }
  addLocked(31, 'Secret', PASSWORD, plainBody('Secret'))
  addLocked(32, 'Other Password', 'something else', plainBody('Other Password'))
  const withImage = `With Image\n${OBJ}\n`
  addLocked(
    33,
    'With Image',
    PASSWORD,
    encodeNoteData(withImage, [
      { length: 'With Image\n'.length },
      {
        length: 2,
        attachmentInfo: { attachmentIdentifier: 'ATT-IMG', typeUti: 'public.jpeg' }
      }
    ])
  )
  // Current macOS: ZDATA is the archived envelope; the legacy columns are
  // present but unusable (iteration count 0), as in a real library.
  const addEnvelope = (pk: number, title: string, password: string): void => {
    insertNote.run(pk, 3, title, 20, 1, crypto.randomBytes(16), 0, crypto.randomBytes(16))
    insertData.run(
      pk,
      lockNoteEnvelope(password, plainBody(title)),
      crypto.randomBytes(16),
      crypto.randomBytes(16)
    )
  }
  addEnvelope(34, 'Envelope Secret', PASSWORD)
  addEnvelope(35, 'Envelope Other', 'something else')
  db.close()
}

describe('locked Apple Notes (synthetic NoteStore.sqlite)', () => {
  let tempVault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult
  let dbDir: string
  let dbPath: string
  let importer: typeof AppleNotesImporterModule
  let importContext: typeof ImportContextModule

  beforeEach(async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    tempVault = createTestVault('apple-notes-locked-test')
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-notes-locked-'))
    dbPath = path.join(dbDir, 'NoteStore.sqlite')
    buildLockedDb(dbPath)

    const vaultIndex = await import('../../vault/index')
    const database = await import('../../database')
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
      journalDateFormat: 'YYYY-MM-DD',
      attachmentsFolder: 'attachments'
    } satisfies VaultConfig)
    vi.spyOn(database, 'getDatabase').mockReturnValue(dataDb.db as never)
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(indexDb.db)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {})
    startProjectionRuntime([createNoteDerivedStateProjector(() => tempVault.path)])

    importer = await import('./apple-notes-importer')
    importContext = await import('../import-context')
  })

  afterEach(async () => {
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    tempVault.cleanup()
    fs.rmSync(dbDir, { recursive: true, force: true })
  })

  const run = (options?: Record<string, unknown>) =>
    importer.appleNotesImporter.run(
      { sourcePaths: [dbPath], options },
      importContext.createImportContext('locked', new AbortController().signal)
    )
  const noteFile = (title: string) =>
    path.join(tempVault.path, 'Apple Notes', 'Work', `${title}.md`)
  const codes = (summary: Awaited<ReturnType<typeof run>>) =>
    Object.fromEntries(
      (summary.skippedReasons ?? []).map((g) => [
        typeof g.reason === 'string' ? g.reason : g.reason.code,
        g.count
      ])
    )

  it('imports locked notes the password unlocks, and groups the rest by why they stayed out', async () => {
    const summary = await run({ notesPassword: PASSWORD })

    expect(summary.failed).toEqual([])
    expect(summary.imported).toBe(4)
    expect(fs.readFileSync(noteFile('Secret'), 'utf8')).toContain('body of Secret')
    expect(fs.existsSync(noteFile('Open Note'))).toBe(true)
    expect(fs.readFileSync(noteFile('Envelope Secret'), 'utf8')).toContain(
      'body of Envelope Secret'
    )
    expect(fs.existsSync(noteFile('Other Password'))).toBe(false)
    expect(fs.existsSync(noteFile('Envelope Other'))).toBe(false)
    expect(codes(summary)).toEqual({
      [IMPORT_MESSAGE_CODES.appleNotesLockedWrongPassword]: 2,
      [IMPORT_MESSAGE_CODES.appleNotesLockedAttachment]: 1
    })
  })

  it('imports the text of a locked note whose attachment is not decrypted, without a dead image link', async () => {
    await run({ notesPassword: PASSWORD })
    const md = fs.readFileSync(noteFile('With Image'), 'utf8')
    expect(md).toContain('With Image')
    expect(md).not.toContain('![](')
  })

  it('keeps every locked note out when no password is given', async () => {
    const summary = await run()
    expect(summary.imported).toBe(1)
    expect(codes(summary)).toEqual({ [IMPORT_MESSAGE_CODES.appleNotesLockedNote]: 5 })
  })

  it('skips every locked note on a wrong password and never echoes it', async () => {
    const summary = await run({ notesPassword: 'definitely wrong' })
    expect(summary.imported).toBe(1)
    expect(codes(summary)).toEqual({ [IMPORT_MESSAGE_CODES.appleNotesLockedWrongPassword]: 5 })
    expect(JSON.stringify(summary)).not.toContain('definitely wrong')
  })

  it('reports locked notes in the folder scan and how many a password unlocks', async () => {
    expect((await scanAppleNotesFolders(dbPath)).lockedNoteCount).toBe(5)
    expect(await checkNotesUnlock(dbPath, PASSWORD)).toEqual({ unlocked: 3, total: 5 })
    expect(await checkNotesUnlock(dbPath, 'nope')).toEqual({ unlocked: 0, total: 5 })
  })
})
