/**
 * Writes that target a binary note row (#5607). A stray row an older Windows
 * build made of a pasted attachment names a file in `attachments/<noteId>/`,
 * which a markdown note still embeds: deleting the row keeps the file, here
 * and when a peer's delete applies. A block moved into any binary note is
 * refused, because the markdown would overwrite the file.
 *
 * @module vault/binary-note-rows.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as Y from 'yjs'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { createTestVault } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { insertNoteCache } from '@main/database/queries/notes'
import { upsertNoteMetadata } from '@memry/storage-data'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false, getVersion: () => '0.0.0' },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), trashItem: vi.fn() }
}))
vi.mock('../database', () => ({
  getIndexDatabase: vi.fn(),
  getDatabase: vi.fn(),
  requireDatabase: vi.fn(),
  isDatabaseInitialized: () => true,
  updateFtsContent: vi.fn()
}))
vi.mock('./status', async () => await import('./index'))
vi.mock('./index', () => ({
  emitIndexProgress: vi.fn(),
  getConfig: vi.fn(() => ({
    excludePatterns: [],
    defaultNoteFolder: 'notes',
    journalFolder: 'journal',
    journalDateFormat: 'YYYY-MM-DD',
    attachmentsFolder: 'attachments'
  })),
  getStatus: vi.fn()
}))
vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  removePendingNoteSyncItems: vi.fn()
}))
vi.mock('../sync/crdt-provider', () => {
  const stub = {
    getDoc: () => undefined,
    hasPersistence: () => true,
    awaitPendingInit: async () => {},
    isNoteLocalOnly: () => false,
    isAwaitingMerge: () => false,
    open: vi.fn(async () => new Y.Doc()),
    withDocLoaded: vi.fn(async (_id: string, run: () => void) => run()),
    closeIfInactive: async () => {},
    whenPersisted: async () => {},
    purge: vi.fn(async () => {})
  }
  return { ORIGIN_LOCAL: 'local', getCrdtProvider: vi.fn(() => stub) }
})
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))
vi.mock('../database/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDatabase: vi.fn(),
  getIndexDatabase: vi.fn()
}))

import { getDatabase, getIndexDatabase } from '../database'
import {
  getDatabase as getClientDatabase,
  getIndexDatabase as getClientIndexDatabase
} from '../database/client'
import { getStatus } from './index'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import { startProjectionRuntime, stopProjectionRuntime } from '../projections'
import { deleteNoteCommand } from '../notes/domain'
import { enqueueLocalSyncDelete } from '../sync/local-mutations'
import { noteHandler } from '../sync/item-handlers/note-handler'
import { appendBlocksToNote } from './append-blocks'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('a binary note row', () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult

  beforeEach(() => {
    vault = createTestVault('attachment-store-row-delete')
    data = createTestDataDb()
    index = createTestIndexDb()
    vi.mocked(getDatabase).mockReturnValue(asClientDb(data.db))
    vi.mocked(getClientDatabase).mockReturnValue(asClientDb(data.db))
    vi.mocked(getIndexDatabase).mockReturnValue(index.db)
    vi.mocked(getClientIndexDatabase).mockReturnValue(index.db)
    vi.mocked(getStatus).mockReturnValue({
      isOpen: true,
      path: vault.path,
      isIndexing: false,
      indexProgress: 100,
      error: null
    })
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])
  })

  afterEach(async () => {
    await stopProjectionRuntime({ drain: true })
    index.close()
    data.close()
    vault.cleanup()
    vi.clearAllMocks()
  })

  /** A synced row, its index row and its file. */
  function note(id: string, relativePath: string, bytes: Buffer | string = PNG): void {
    const fields = {
      id,
      path: relativePath,
      title: path.basename(relativePath, path.extname(relativePath)),
      fileType: typeof bytes === 'string' ? ('markdown' as const) : ('image' as const),
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z',
      syncedAt: '2026-01-12T00:00:00.000Z',
      fileSize: bytes.length
    }
    upsertNoteMetadata(asClientDb(data.db), fields)
    insertNoteCache(index.db, { ...fields, contentHash: null })
    const absolutePath = path.join(vault.path, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, bytes)
  }

  const onDisk = (relativePath: string): boolean =>
    fs.existsSync(path.join(vault.path, relativePath))
  const rowIds = (): string[] =>
    data.db
      .select({ id: noteMetadata.id })
      .from(noteMetadata)
      .all()
      .map((r) => r.id)
  const deletes = () => vi.mocked(enqueueLocalSyncDelete).mock.calls

  it('in the attachment store: a delete drops the row, queues its tombstone and keeps the file', async () => {
    note('stray', 'attachments/host-note/pasted.png')

    await deleteNoteCommand('stray')

    expect({
      file: onDisk('attachments/host-note/pasted.png'),
      rows: rowIds(),
      deletes: deletes()
    }).toEqual({ file: true, rows: [], deletes: [['note', 'stray']] })
  })

  it("in the attachment store: a peer's delete drops the row and keeps the file", () => {
    note('stray', 'attachments/host-note/pasted.png')

    expect(noteHandler.applyDelete({ db: asClientDb(data.db), emit: vi.fn() }, 'stray')).toBe(
      'applied'
    )

    expect({ file: onDisk('attachments/host-note/pasted.png'), rows: rowIds() }).toEqual({
      file: true,
      rows: []
    })
  })

  // A nested `attachments` folder holds the user's notes (#3161).
  it('in a nested attachments folder: a delete removes the file', async () => {
    note('photo', 'Projects/attachments/photo.png')

    await deleteNoteCommand('photo')

    expect({ file: onDisk('Projects/attachments/photo.png'), rows: rowIds() }).toEqual({
      file: false,
      rows: []
    })
  })

  it('takes no block moved into it, and its file keeps its bytes', async () => {
    note('source', 'notes/source.md', '# source\n\nmoved\n')
    note('photo', 'notes/photo.png')

    await expect(
      appendBlocksToNote({ sourceNoteId: 'source', targetNoteId: 'photo', markdown: 'moved' })
    ).rejects.toMatchObject({ code: 'NOTE_NOT_MARKDOWN', message: 'errors:note.appendIntoBinary' })
    expect(fs.readFileSync(path.join(vault.path, 'notes/photo.png'))).toEqual(PNG)
  })
})
