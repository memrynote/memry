import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import type { VaultStatus, VaultConfig } from '@memry/contracts/vault-api'
import {
  startProjectionRuntime,
  stopProjectionRuntime,
  flushProjectionEvents
} from '../projections'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import * as vaultIndex from './index'
import * as database from '../database'
import * as notes from './notes'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() }
}))
vi.mock('../inbox/suggestions', () => ({ updateNoteEmbedding: vi.fn(async () => undefined) }))
vi.mock('../sync/crdt-external-feed', () => ({ feedExternalEditToCrdt: vi.fn(async () => false) }))

describe('createCloseSnapshot', () => {
  let vault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  beforeEach(() => {
    vault = createTestVault('notes-close-snapshot')
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    vi.spyOn(vaultIndex, 'getStatus').mockReturnValue({
      isOpen: true,
      path: vault.path,
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
    vi.spyOn(database, 'getDatabase').mockReturnValue(asClientDb(dataDb.db))
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(indexDb.db)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {})
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])
  })

  afterEach(async () => {
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    vault.cleanup()
  })

  const createNote = async (title: string): Promise<notes.Note> => {
    const note = await notes.createNote({ title, content: `${title} body.` })
    await flushProjectionEvents()
    return note
  }

  const storedContents = (noteId: string): Array<string | undefined> =>
    notes.getVersionHistory(noteId).map((item) => notes.getVersion(item.id)?.fileContent)

  it('keeps the file on disk as a close version, once per content', async () => {
    const note = await createNote('Open')
    const onDisk = fs.readFileSync(path.join(vault.path, note.path), 'utf-8')

    expect(await notes.createCloseSnapshot(note.id)).toBe(true)
    expect(await notes.createCloseSnapshot(note.id)).toBe(false)
    expect(storedContents(note.id)).toEqual([onDisk])
  })

  it('keeps nothing for a note without a row or with an empty file', async () => {
    const note = await createNote('Empty')
    fs.writeFileSync(path.join(vault.path, note.path), '')

    expect(await notes.createCloseSnapshot('missing-note')).toBe(false)
    expect(await notes.createCloseSnapshot(note.id)).toBe(false)
    expect(storedContents(note.id)).toEqual([])
  })
})
