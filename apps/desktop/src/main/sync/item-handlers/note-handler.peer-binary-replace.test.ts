/**
 * A peer replaces the bytes of an image, PDF, audio or video note: its record
 * arrives with a new `attachmentId` (#5580). The pull asks for the new
 * attachment onto this device's file, and a change made here that is on no
 * server is kept as a conflict copy before the bytes land.
 *
 * @module sync/item-handlers/note-handler.peer-binary-replace.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { createTestVault } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { insertNoteCache } from '@main/database/queries/notes'
import { updateNoteMetadata, upsertNoteMetadata } from '@memry/storage-data'
import { attachmentEvents } from '@memry/sync-client/attachment-events'
import type { NoteSyncPayload } from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false, getVersion: () => '0.0.0' },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), trashItem: vi.fn() }
}))
vi.mock('../../database', () => ({
  getIndexDatabase: vi.fn(),
  getDatabase: vi.fn(),
  requireDatabase: vi.fn(),
  isDatabaseInitialized: () => true,
  updateFtsContent: vi.fn()
}))
vi.mock('../../vault/status', async () => await import('../../vault/index'))
vi.mock('../../vault/index', () => ({
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
vi.mock('../local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  removePendingNoteSyncItems: vi.fn()
}))
vi.mock('../crdt-provider', () => ({
  ORIGIN_LOCAL: 'local',
  getCrdtProvider: vi.fn(() => ({
    initForNote: vi.fn(async () => {}),
    updateMeta: vi.fn(),
    getDoc: () => undefined,
    recordOwedFullState: vi.fn(),
    hasPersistence: () => true,
    awaitPendingInit: async () => {},
    readOnlyStore: () => ({ docNames: async () => [], updates: async () => [] }),
    isNoteLocalOnly: () => false,
    isAwaitingMerge: () => false,
    purge: vi.fn(async () => {})
  }))
}))
vi.mock('../attachment-backfill', () => ({ queueEmbeddedVaultFiles: vi.fn() }))
vi.mock('../../tasks/reconcile-markdown-tasks', () => ({
  reconcileTaskCheckboxesFromMarkdown: vi.fn(async () => 0)
}))
vi.mock('../../inbox/suggestions', () => ({ updateNoteEmbedding: vi.fn() }))
vi.mock('../../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))
vi.mock('../../database/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDatabase: vi.fn(),
  getIndexDatabase: vi.fn()
}))

import { getDatabase, getIndexDatabase } from '../../database'
import {
  getDatabase as getClientDatabase,
  getIndexDatabase as getClientIndexDatabase
} from '../../database/client'
import { getStatus } from '../../vault/index'
import { recordAppWrite } from '../../vault/app-writes'
import { createNoteDerivedStateProjector } from '../../projections/projectors/note-derived-state-projector'
import {
  flushProjectionEvents,
  startProjectionRuntime,
  stopProjectionRuntime
} from '../../projections'
import { clearIngestBackfill, drainIngestBackfill } from '../../vault/ingest-backfill'
import { clearAllPendingDeletes } from '../../vault/rename-tracker'
import { startWatcher, stopWatcher } from '../../vault/watcher'
import { landCaseTwinDownload } from '../../vault/case-twin-landing'
import { noteHandler } from './note-handler'
import { recordDownloadedFileSize, recordUploadedAttachment } from '../note-attachment-metadata'
import { enqueueLocalSyncUpdate } from '../local-mutations'
import { SupersededDownloadError } from '../attachment-errors'
import { enqueueUpload } from '../attachment-outbox'
import { readSyncedBinaryHash } from '../binary-synced-hash'
import { deleteNoteFromCache } from '../../vault/note-sync'
import { resetAttachmentDownloadSession } from '@memry/sync-client/attachment-download-state'

function fileSystemIgnoresCase(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-case-probe-'))
  try {
    fs.writeFileSync(path.join(dir, 'probe'), '')
    return fs.existsSync(path.join(dir, 'PROBE'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe("a peer's replacement of a binary note's bytes", () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  const saved = vi.fn()
  const downloads = vi.fn()
  const onSaved = (event: { noteId: string }) => saved(event.noteId)
  const onDownload = (event: { noteId: string; attachmentId: string; diskPath: string }) =>
    downloads(event.noteId, event.attachmentId, event.diskPath)
  const abs = (relativePath: string) => path.join(vault.path, relativePath)
  const read = (relativePath: string) => fs.readFileSync(abs(relativePath), 'utf8')

  beforeEach(() => {
    vault = createTestVault('peer-binary-replace')
    // The watcher takes a vault without its database for one that went away.
    fs.writeFileSync(path.join(vault.memryDir, 'data.db'), '')
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
    attachmentEvents.onSaved(onSaved)
    attachmentEvents.onDownloadNeeded(onDownload)
  })

  afterEach(async () => {
    attachmentEvents.offSaved(onSaved)
    attachmentEvents.offDownloadNeeded(onDownload)
    await stopWatcher()
    await stopProjectionRuntime({ drain: true })
    clearIngestBackfill()
    clearAllPendingDeletes()
    resetAttachmentDownloadSession()
    index.close()
    data.close()
    vault.cleanup()
    vi.clearAllMocks()
  })

  /** A synced image note: its canonical and index rows, and the bytes it last downloaded on disk. */
  function seed(id: string, relativePath: string, bytes: string, landed = true): void {
    const fields = {
      id,
      path: relativePath,
      title: path.basename(relativePath, path.extname(relativePath)),
      fileType: 'image' as const,
      mimeType: 'image/png',
      attachmentId: `att-${id}`,
      localOnly: false,
      clock: { dev1: 1 },
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z',
      syncedAt: '2026-01-12T00:00:00.000Z',
      fileSize: bytes.length
    }
    upsertNoteMetadata(asClientDb(data.db), fields)
    insertNoteCache(index.db, { ...fields, contentHash: null })
    fs.mkdirSync(path.dirname(abs(relativePath)), { recursive: true })
    const written = recordAppWrite(abs(relativePath), bytes)
    fs.writeFileSync(abs(relativePath), bytes)
    written()
    if (landed) recordDownloadedFileSize(id, `att-${id}`, bytes.length, sha256(bytes))
  }

  /** The peer's record for note `id`, as a pull applies it. */
  function pull(
    id: string,
    attachmentId: string,
    clock: VectorClock = { dev1: 1, peer: 1 },
    folderPath = 'Pictures'
  ) {
    const payload: NoteSyncPayload = {
      title: 'p',
      folderPath,
      fileType: 'image',
      mimeType: 'image/png',
      attachmentId,
      clock,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-13T00:00:00.000Z'
    }
    return noteHandler.applyUpsert({ db: asClientDb(data.db), emit: vi.fn() }, id, payload, clock)
  }

  /** The downloader landing an asked-for attachment: `beforeFileLands`, the rename, the size. */
  function land(id: string, attachmentId: string, requestedPath: string, bytes: string): void {
    const at = landCaseTwinDownload(requestedPath, attachmentId, sha256(bytes), id)
    // The downloader records the verified file's hash and never reports it landed.
    recordAppWrite(at, { sha256: sha256(bytes) })
    fs.writeFileSync(at, bytes)
    recordDownloadedFileSize(id, attachmentId, bytes.length, sha256(bytes))
  }

  const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex')

  const conflictCopies = (folder: string) =>
    fs
      .readdirSync(abs(folder))
      .filter((name) => name.includes('(conflict copy)'))
      .map((name) => fs.readFileSync(path.join(abs(folder), name), 'utf8'))

  const attachmentOf = (id: string) =>
    data.db
      .select()
      .from(noteMetadata)
      .all()
      .find((row) => row.id === id)?.attachmentId

  it("lands the peer's new bytes on this device's file", () => {
    seed('img', 'Pictures/p.png', 'old-bytes')

    expect(pull('img', 'att-new')).toBe('applied')

    expect(attachmentOf('img')).toBe('att-new')
    expect(downloads.mock.calls).toEqual([['img', 'att-new', abs('Pictures/p.png')]])
    land('img', 'att-new', abs('Pictures/p.png'), 'peer-bytes')
    expect(read('Pictures/p.png')).toBe('peer-bytes')
    expect(conflictCopies('Pictures')).toEqual([])
  })

  it('lands the new bytes at the path a rename in the same record moved the file to', () => {
    seed('img', 'Pictures/p.png', 'old-bytes')

    expect(pull('img', 'att-new', { dev1: 1, peer: 1 }, 'Moved')).toBe('applied')

    expect(downloads.mock.calls).toEqual([['img', 'att-new', abs('Moved/p.png')]])
    land('img', 'att-new', abs('Moved/p.png'), 'peer-bytes')
    expect(read('Moved/p.png')).toBe('peer-bytes')
    expect(conflictCopies('Moved')).toEqual([])
  })

  it('asks for nothing when the record carries the attachment this device has', () => {
    seed('img', 'Pictures/p.png', 'old-bytes')

    expect(pull('img', 'att-img')).toBe('applied')
    pull('img', 'att-img')

    expect(downloads).not.toHaveBeenCalled()
    expect(read('Pictures/p.png')).toBe('old-bytes')
  })

  it('keeps a local edit whose upload is pending as a conflict copy', () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    // What the watcher and the saved handler record for an outside edit.
    fs.writeFileSync(abs('Pictures/p.png'), 'local-edit')
    updateNoteMetadata(asClientDb(data.db), 'img', { fileSize: 'local-edit'.length })
    enqueueUpload(asClientDb(data.db), 'img', abs('Pictures/p.png'))

    expect(pull('img', 'att-new')).toBe('applied')
    land('img', 'att-new', abs('Pictures/p.png'), 'peer-bytes')

    expect(read('Pictures/p.png')).toBe('peer-bytes')
    expect(conflictCopies('Pictures')).toEqual(['local-edit'])
  })

  it('keeps a local edit the watcher has not seen as a conflict copy', () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    fs.writeFileSync(abs('Pictures/p.png'), 'edited while closed')

    expect(pull('img', 'att-new')).toBe('applied')
    land('img', 'att-new', abs('Pictures/p.png'), 'peer-bytes')

    expect(read('Pictures/p.png')).toBe('peer-bytes')
    expect(conflictCopies('Pictures')).toEqual(['edited while closed'])
  })

  it('keeps a same-size edit made while the app was closed as a conflict copy', () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    fs.writeFileSync(abs('Pictures/p.png'), 'new-bytes')

    expect(pull('img', 'att-new')).toBe('applied')
    land('img', 'att-new', abs('Pictures/p.png'), 'peer-bytes')

    expect(read('Pictures/p.png')).toBe('peer-bytes')
    expect(conflictCopies('Pictures')).toEqual(['new-bytes'])
  })

  it('keeps the bytes of a note with no synced hash recorded as a conflict copy', () => {
    seed('img', 'Pictures/p.png', 'old-bytes', false)

    expect(pull('img', 'att-new')).toBe('applied')
    land('img', 'att-new', abs('Pictures/p.png'), 'peer-bytes')

    expect(read('Pictures/p.png')).toBe('peer-bytes')
    expect(conflictCopies('Pictures')).toEqual(['old-bytes'])
  })

  it('lands over bytes this device uploaded without a conflict copy', () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    fs.writeFileSync(abs('Pictures/p.png'), 'up-bytes!')
    recordUploadedAttachment('img', 'att-up', sha256('up-bytes!'))
    expect(attachmentOf('img')).toBe('att-up')

    expect(pull('img', 'att-new', { dev1: 2, peer: 1 })).toBe('applied')
    land('img', 'att-new', abs('Pictures/p.png'), 'peer-bytes')

    expect(read('Pictures/p.png')).toBe('peer-bytes')
    expect(conflictCopies('Pictures')).toEqual([])
  })

  it('forgets the synced hash with the note', () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    expect(readSyncedBinaryHash(asClientDb(data.db), 'img')).toBe(sha256('old-bytes'))

    deleteNoteFromCache(index.db, 'img')

    expect(readSyncedBinaryHash(asClientDb(data.db), 'img')).toBeUndefined()
  })

  it("keeps this device's concurrent replacement as a conflict copy", () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    // Uploaded and recorded here, its push not yet on the server.
    fs.writeFileSync(abs('Pictures/p.png'), 'mine')
    updateNoteMetadata(asClientDb(data.db), 'img', {
      attachmentId: 'att-mine',
      fileSize: 'mine'.length,
      clock: { dev1: 2 }
    })

    expect(pull('img', 'att-new')).toBe('conflict')
    land('img', 'att-new', abs('Pictures/p.png'), 'peer-bytes')

    expect(read('Pictures/p.png')).toBe('peer-bytes')
    expect(conflictCopies('Pictures')).toEqual(['mine'])
  })

  it('holds an edit made while the new bytes download, and keeps it as a conflict copy', async () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    seed('control', 'Pictures/c.png', 'c-bytes')
    expect(pull('img', 'att-new')).toBe('applied')
    await startWatcher(vault.path)

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10_000 })
    try {
      await vi.waitFor(
        async () => {
          fs.writeFileSync(abs('Pictures/p.png'), 'edit-during-download')
          fs.writeFileSync(abs('Pictures/c.png'), 'control-edit')
          await new Promise((resolve) => setTimeout(resolve, 400))
          await flushProjectionEvents()
          expect(saved.mock.calls.map(([id]) => id)).toContain('control')
        },
        { timeout: 15_000, interval: 100 }
      )
      await drainIngestBackfill()
      await flushProjectionEvents()
    } finally {
      vi.useRealTimers()
    }

    expect(saved.mock.calls.map(([id]) => id)).not.toContain('img')
    land('img', 'att-new', abs('Pictures/p.png'), 'peer-bytes')
    expect(read('Pictures/p.png')).toBe('peer-bytes')
    expect(conflictCopies('Pictures')).toEqual(['edit-during-download'])
  }, 30_000)

  it('keeps no conflict copy when the change it merged with left the bytes alone', () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    // An icon or a rename changed here; its push is not on the server yet.
    updateNoteMetadata(asClientDb(data.db), 'img', { clock: { dev1: 2 } })

    expect(pull('img', 'att-new')).toBe('conflict')
    land('img', 'att-new', abs('Pictures/p.png'), 'peer-bytes')

    expect(read('Pictures/p.png')).toBe('peer-bytes')
    expect(conflictCopies('Pictures')).toEqual([])
  })

  /** Bytes this device uploaded at clock `{dev1: 1}`: its next push, at dev1 2, carries them. */
  function uploadHere(bytes: string): void {
    data.db
      .insert(syncDevices)
      .values({
        id: 'dev1',
        name: 'This Mac',
        platform: 'macos',
        appVersion: '0.0.0',
        linkedAt: new Date(),
        isCurrentDevice: true,
        signingPublicKey: 'key'
      })
      .run()
    seed('img', 'Pictures/p.png', 'old-bytes')
    fs.writeFileSync(abs('Pictures/p.png'), bytes)
    recordUploadedAttachment('img', 'att-up', sha256(bytes))
  }

  it('keeps no conflict copy of uploaded bytes the merged record has seen', () => {
    uploadHere('up-bytes!')
    // Pushed at dev1 2, then renamed here at dev1 3.
    updateNoteMetadata(asClientDb(data.db), 'img', { clock: { dev1: 3 } })

    expect(pull('img', 'att-new', { dev1: 2, peer: 1 })).toBe('conflict')
    land('img', 'att-new', abs('Pictures/p.png'), 'peer-bytes')

    expect(read('Pictures/p.png')).toBe('peer-bytes')
    expect(conflictCopies('Pictures')).toEqual([])
  })

  it('keeps uploaded bytes the merged record has not seen as a conflict copy', () => {
    uploadHere('up-bytes!')
    // Its push, at dev1 2, is not on the server yet.
    updateNoteMetadata(asClientDb(data.db), 'img', { clock: { dev1: 2 } })

    expect(pull('img', 'att-new', { dev1: 1, peer: 1 })).toBe('conflict')
    land('img', 'att-new', abs('Pictures/p.png'), 'peer-bytes')

    expect(read('Pictures/p.png')).toBe('peer-bytes')
    expect(conflictCopies('Pictures')).toEqual(['up-bytes!'])
  })

  it('drops an older replacement that finishes after a newer one landed', () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    expect(pull('img', 'att-b')).toBe('applied')
    expect(pull('img', 'att-c', { dev1: 1, peer: 2 })).toBe('applied')
    expect(downloads.mock.calls.map(([, id]) => id)).toEqual(['att-b', 'att-c'])

    land('img', 'att-c', abs('Pictures/p.png'), 'c-bytes')
    expect(() => land('img', 'att-b', abs('Pictures/p.png'), 'b-bytes')).toThrow(
      SupersededDownloadError
    )

    expect(attachmentOf('img')).toBe('att-c')
    expect(read('Pictures/p.png')).toBe('c-bytes')
    expect(conflictCopies('Pictures')).toEqual([])
  })

  it('drops an older replacement that finishes first, and lands the newer one', () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    expect(pull('img', 'att-b')).toBe('applied')
    expect(pull('img', 'att-c', { dev1: 1, peer: 2 })).toBe('applied')

    expect(() => land('img', 'att-b', abs('Pictures/p.png'), 'b-bytes')).toThrow(
      SupersededDownloadError
    )
    expect(read('Pictures/p.png')).toBe('old-bytes')
    land('img', 'att-c', abs('Pictures/p.png'), 'c-bytes')

    expect(read('Pictures/p.png')).toBe('c-bytes')
    expect(conflictCopies('Pictures')).toEqual([])
  })

  it('keeps holding the file when the record moves on between a landing and its size', async () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    expect(pull('img', 'att-b')).toBe('applied')
    const at = landCaseTwinDownload(abs('Pictures/p.png'), 'att-b', sha256('b-bytes'), 'img')
    recordAppWrite(at, { sha256: sha256('b-bytes') })
    fs.writeFileSync(at, 'b-bytes')
    // A newer replacement applies before the landing records its size.
    expect(pull('img', 'att-c', { dev1: 1, peer: 2 })).toBe('applied')
    recordDownloadedFileSize('img', 'att-b', 'b-bytes'.length, sha256('b-bytes'))

    // An edit made now is on no server: it is held, and kept when C lands.
    await startWatcher(vault.path)
    seed('control', 'Pictures/c.png', 'c-bytes')
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10_000 })
    try {
      await vi.waitFor(
        async () => {
          fs.writeFileSync(abs('Pictures/p.png'), 'edit-after-b')
          fs.writeFileSync(abs('Pictures/c.png'), 'control-edit')
          await new Promise((resolve) => setTimeout(resolve, 400))
          await flushProjectionEvents()
          expect(saved.mock.calls.map(([id]) => id)).toContain('control')
        },
        { timeout: 15_000, interval: 100 }
      )
      await drainIngestBackfill()
      await flushProjectionEvents()
    } finally {
      vi.useRealTimers()
    }

    expect(saved.mock.calls.map(([id]) => id)).not.toContain('img')
    land('img', 'att-c', abs('Pictures/p.png'), 'peer-c')
    expect(read('Pictures/p.png')).toBe('peer-c')
    expect(conflictCopies('Pictures')).toEqual(['edit-after-b'])
  }, 30_000)

  it("keeps an upload that finishes after the pull off the peer's note, as the conflict copy", () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    fs.writeFileSync(abs('Pictures/p.png'), 'local-edit')
    updateNoteMetadata(asClientDb(data.db), 'img', { fileSize: 'local-edit'.length })
    enqueueUpload(asClientDb(data.db), 'img', abs('Pictures/p.png'))
    expect(pull('img', 'att-b')).toBe('applied')

    // The upload of the local edit was in flight; it finishes now.
    recordUploadedAttachment('img', 'att-local')

    expect(attachmentOf('img')).toBe('att-b')
    expect(enqueueLocalSyncUpdate).not.toHaveBeenCalledWith('note', 'img')
    land('img', 'att-b', abs('Pictures/p.png'), 'b-bytes')
    expect(attachmentOf('img')).toBe('att-b')
    expect(read('Pictures/p.png')).toBe('b-bytes')
    expect(conflictCopies('Pictures')).toEqual(['local-edit'])
  })

  it("keeps an upload that finishes after the peer's bytes landed off the note", () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    fs.writeFileSync(abs('Pictures/p.png'), 'local-edit')
    updateNoteMetadata(asClientDb(data.db), 'img', { fileSize: 'local-edit'.length })
    enqueueUpload(asClientDb(data.db), 'img', abs('Pictures/p.png'))
    expect(pull('img', 'att-b')).toBe('applied')
    land('img', 'att-b', abs('Pictures/p.png'), 'b-bytes')
    expect(conflictCopies('Pictures')).toEqual(['local-edit'])

    // The upload of the local edit was in flight; it finishes after the landing.
    recordUploadedAttachment('img', 'att-local', sha256('local-edit'))

    expect(attachmentOf('img')).toBe('att-b')
    expect(enqueueLocalSyncUpdate).not.toHaveBeenCalledWith('note', 'img')
    expect(read('Pictures/p.png')).toBe('b-bytes')
    expect(readSyncedBinaryHash(asClientDb(data.db), 'img')).toBe(sha256('b-bytes'))
  })

  it.runIf(fileSystemIgnoresCase())(
    "leaves a file a case twin shares alone: it holds one twin's bytes",
    () => {
      seed('twin-a', 'Pictures/p.png', 'a-bytes')
      seed('twin-b', 'PICTURES/p.png', 'b-bytes')

      expect(pull('twin-b', 'att-new', { dev1: 1, peer: 1 }, 'PICTURES')).toBe('applied')

      expect(downloads).not.toHaveBeenCalled()
      expect(read('Pictures/p.png')).toBe('b-bytes')
    }
  )
})
