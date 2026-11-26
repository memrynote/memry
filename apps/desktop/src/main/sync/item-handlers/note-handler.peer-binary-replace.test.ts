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
import type * as PromisesModule from 'fs/promises'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
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
import { SyncQueueManager } from '@memry/sync-client/queue'
import { recordTombstoneClock } from '@memry/sync-client/tombstone-clocks'
import type { NoteSyncPayload } from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'

const hashing = vi.hoisted(() => ({
  /** Hashes that started. */
  opens: 0,
  /** Set: a hash opens its file only when this resolves. */
  open: null as Promise<void> | null,
  /** Hashes that read their file. */
  reads: 0,
  /** Set: runs once a hash read its file. */
  onRead: null as (() => void) | null,
  /** Set: a hash, once it read the file, answers only when this resolves. */
  answer: null as Promise<void> | null,
  /** Set: runs as a stat of a file starts. */
  onStat: null as ((filePath: string) => void) | null,
  /** Set: runs before a rename, which fails when it rejects. */
  onRename: null as ((from: string) => Promise<void>) | null
}))

vi.mock('../../vault/file-hash-bridge', async () => {
  const { sha256OfFile } = await import('../../vault/file-sha256')
  return {
    hashFileOffThread: async (filePath: string) => {
      hashing.opens++
      await hashing.open
      const sha256 = await sha256OfFile(filePath)
      hashing.reads++
      hashing.onRead?.()
      await hashing.answer
      return sha256
    }
  }
})
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof PromisesModule>()
  const stat = ((...args: Parameters<typeof actual.stat>) => {
    hashing.onStat?.(String(args[0]))
    return actual.stat(...args)
  }) as typeof actual.stat
  const rename: typeof actual.rename = async (from, to) => {
    await hashing.onRename?.(String(from))
    return actual.rename(from, to)
  }
  return { ...actual, stat, rename }
})
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
vi.mock('../../ipc/settings-handlers', () => ({ followFolderRenameInShortcuts: vi.fn() }))
vi.mock('../../readwise/settings', () => ({ followFolderRenameInReadwise: vi.fn() }))
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
import {
  recordDownloadedFileSize,
  recordUploadedAttachment,
  recordUploadedFile
} from '../note-attachment-metadata'
import { registerManifestChecksumReader, settleBinaryHashCheck } from '../binary-hash-check'
import type { DownloadNetOptions } from '../attachments'
import { SyncServerError } from '@memry/sync-client/http-errors'
import { enqueueLocalSyncUpdate } from '../local-mutations'
import { NoteSyncService } from '../note-sync'
import { SupersededDownloadError } from '../attachment-errors'
import { enqueueUpload } from '../attachment-outbox'
import { readSyncedBinaryHash } from '../binary-synced-hash'
import { readCaseTwinForeignBytes } from '../../vault/case-twin-bytes'
import { deleteNoteFromCache } from '../../vault/note-sync'
import { renameNote } from '../../vault/notes-rename'
import { renameFolderCommand } from '../../notes/domain'
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
  /** The server's manifest checksums, by attachment id; any other id is gone (404). */
  const manifests = new Map<string, string>()
  const paceManifestRead = vi.fn(async () => {})
  /** Paces before it asks, as the attachment service's retried requests do. */
  const readChecksum = vi.fn(async (attachmentId: string, net: DownloadNetOptions) => {
    await net.pace?.()
    const checksum = manifests.get(attachmentId)
    if (checksum === undefined) throw new SyncServerError('Failed to fetch manifest', 404)
    return checksum
  })
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
    registerManifestChecksumReader({ checksumOf: readChecksum, pace: paceManifestRead })
  })

  afterEach(async () => {
    attachmentEvents.offSaved(onSaved)
    attachmentEvents.offDownloadNeeded(onDownload)
    registerManifestChecksumReader(null)
    // Drops the answers a test queued for reads that never came.
    readChecksum.mockReset()
    paceManifestRead.mockReset()
    vi.mocked(enqueueLocalSyncUpdate).mockReset()
    hashing.opens = 0
    hashing.open = null
    hashing.reads = 0
    hashing.onRead = null
    hashing.answer = null
    hashing.onStat = null
    hashing.onRename = null
    manifests.clear()
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

  // A note from before #5603, or after a session teardown cleared sync_state.
  describe('of a note with no synced hash recorded (#5608)', () => {
    it('lands over bytes its attachment holds on the server, and records their hash', async () => {
      seed('img', 'Pictures/p.png', 'old-bytes', false)
      manifests.set('att-img', sha256('old-bytes'))

      expect(pull('img', 'att-new')).toBe('applied')
      await settleBinaryHashCheck('img')

      expect(readChecksum).toHaveBeenCalledWith('att-img', expect.anything())
      expect(readSyncedBinaryHash(asClientDb(data.db), 'img')).toBe(sha256('old-bytes'))
      land('img', 'att-new', abs('Pictures/p.png'), 'peer-bytes')
      expect(read('Pictures/p.png')).toBe('peer-bytes')
      expect(conflictCopies('Pictures')).toEqual([])
    })

    it('keeps bytes other than its attachment holds as a conflict copy', async () => {
      seed('img', 'Pictures/p.png', 'old-bytes', false)
      manifests.set('att-img', sha256('old-bytes'))
      fs.writeFileSync(abs('Pictures/p.png'), 'edited while closed')

      expect(pull('img', 'att-new')).toBe('applied')
      await settleBinaryHashCheck('img')

      expect(readSyncedBinaryHash(asClientDb(data.db), 'img')).toBeUndefined()
      land('img', 'att-new', abs('Pictures/p.png'), 'peer-bytes')
      expect(read('Pictures/p.png')).toBe('peer-bytes')
      expect(conflictCopies('Pictures')).toEqual(['edited while closed'])
    })

    it('keeps its bytes as a conflict copy when the manifest cannot be read', async () => {
      seed('img', 'Pictures/p.png', 'old-bytes', false)

      expect(pull('img', 'att-new')).toBe('applied')
      await settleBinaryHashCheck('img')

      expect(readChecksum).toHaveBeenCalledWith('att-img', expect.anything())
      land('img', 'att-new', abs('Pictures/p.png'), 'peer-bytes')
      expect(read('Pictures/p.png')).toBe('peer-bytes')
      expect(conflictCopies('Pictures')).toEqual(['old-bytes'])
    })

    it('keeps its bytes as a conflict copy, and abandons the read, when the manifest never answers', async () => {
      seed('img', 'Pictures/p.png', 'old-bytes', false)
      readChecksum.mockImplementationOnce(() => new Promise<string>(() => {}))
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        expect(pull('img', 'att-new')).toBe('applied')
        const settled = settleBinaryHashCheck('img')
        await vi.advanceTimersByTimeAsync(30_000)
        await settled
      } finally {
        vi.useRealTimers()
      }

      expect(readChecksum.mock.calls[0]?.[1].signal?.aborted).toBe(true)
      land('img', 'att-new', abs('Pictures/p.png'), 'peer-bytes')
      expect(read('Pictures/p.png')).toBe('peer-bytes')
      expect(conflictCopies('Pictures')).toEqual(['old-bytes'])
    })

    // A landing holds a download slot while it waits (#5617).
    it("answers within the deadline of the replace while other notes' checks run first", async () => {
      const folders = ['A', 'B', 'C']
      for (const folder of folders) {
        seed(folder, `${folder}/p.png`, `${folder}-bytes`, false)
        readChecksum.mockImplementationOnce(() => new Promise<string>(() => {}))
      }
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
      let answered = false
      try {
        for (const folder of folders) {
          expect(pull(folder, `att-new-${folder}`, { dev1: 1, peer: 1 }, folder)).toBe('applied')
        }
        void settleBinaryHashCheck('C').then(() => {
          answered = true
        })
        await vi.advanceTimersByTimeAsync(30_000)
      } finally {
        vi.useRealTimers()
      }

      expect(answered).toBe(true)
      expect(readChecksum.mock.calls.map(([id]) => id)).toEqual(['att-A'])
      land('C', 'att-new-C', abs('C/p.png'), 'peer-bytes')
      expect(conflictCopies('C')).toEqual(['C-bytes'])
    })

    // The pacer holds the downloads too; its wait is no sign the server is not answering.
    it("lands over its attachment's bytes when the pacer holds the read past the deadline", async () => {
      seed('img', 'Pictures/p.png', 'old-bytes', false)
      manifests.set('att-img', sha256('old-bytes'))
      paceManifestRead.mockImplementationOnce(
        () => new Promise<void>((resolve) => setTimeout(resolve, 45_000))
      )
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
      try {
        expect(pull('img', 'att-new')).toBe('applied')
        const settled = settleBinaryHashCheck('img')
        await vi.advanceTimersByTimeAsync(45_000)
        await settled
      } finally {
        vi.useRealTimers()
      }

      expect(paceManifestRead).toHaveBeenCalledTimes(1)
      expect(readSyncedBinaryHash(asClientDb(data.db), 'img')).toBe(sha256('old-bytes'))
      land('img', 'att-new', abs('Pictures/p.png'), 'peer-bytes')
      expect(conflictCopies('Pictures')).toEqual([])
    })

    // A pacer burst holds the landing's download slot only so long (OL-M32).
    it('keeps its bytes as a conflict copy, and abandons the read, when the pacer never lets it go', async () => {
      seed('img', 'Pictures/p.png', 'old-bytes', false)
      manifests.set('att-img', sha256('old-bytes'))
      paceManifestRead.mockImplementationOnce(() => new Promise<void>(() => {}))
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
      let answered = false
      try {
        expect(pull('img', 'att-new')).toBe('applied')
        void settleBinaryHashCheck('img').then(() => {
          answered = true
        })
        await vi.advanceTimersByTimeAsync(60_000)
      } finally {
        vi.useRealTimers()
      }

      expect(answered).toBe(true)
      expect(readChecksum.mock.calls[0]?.[1].signal?.aborted).toBe(true)
      land('img', 'att-new', abs('Pictures/p.png'), 'peer-bytes')
      expect(read('Pictures/p.png')).toBe('peer-bytes')
      expect(conflictCopies('Pictures')).toEqual(['old-bytes'])
    })

    // An explicit download names no note whose check it waits for (`fileOwnerId`).
    it('marks nothing when its new bytes land while the check hashes the old ones', async () => {
      seed('img', 'Pictures/p.png', 'old-bytes', false)
      manifests.set('att-img', sha256('old-bytes'))
      const answer = holdHashes()

      expect(pull('img', 'att-new')).toBe('applied')
      await vi.waitFor(() => expect(hashing.reads).toBe(1))
      const at = landCaseTwinDownload(abs('Pictures/p.png'), 'att-new', sha256('peer-bytes'))
      recordAppWrite(at, { sha256: sha256('peer-bytes') })
      fs.writeFileSync(at, 'peer-bytes')
      recordDownloadedFileSize('img', 'att-new', 'peer-bytes'.length, sha256('peer-bytes'))
      answer()
      await settleBinaryHashCheck('img')

      expect(readCaseTwinForeignBytes(asClientDb(data.db), 'img')).toBeUndefined()
      expect(readSyncedBinaryHash(asClientDb(data.db), 'img')).toBe(sha256('peer-bytes'))
      fs.writeFileSync(abs('Pictures/p.png'), 'new-edit')
      expect(await recordUploadedFile('img', 'att-edit', sha256('new-edit'))).toBe(true)
    })

    it('keeps the file marked when the note is renamed while the check hashes', async () => {
      seed('img', 'Pictures/p.png', 'old-bytes', false)
      manifests.set('att-img', sha256('old-bytes'))
      const answer = holdHashes()

      expect(pull('img', 'att-new')).toBe('applied')
      await vi.waitFor(() => expect(hashing.reads).toBe(1))
      await renameNote('img', 'renamed')
      answer()
      await settleBinaryHashCheck('img')

      expect(read('Pictures/renamed.png')).toBe('old-bytes')
      expect(readCaseTwinForeignBytes(asClientDb(data.db), 'img')).toBeNull()
      expect(readSyncedBinaryHash(asClientDb(data.db), 'img')).toBeUndefined()
    })
  })

  it('lands over bytes this device uploaded without a conflict copy', async () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    fs.writeFileSync(abs('Pictures/p.png'), 'up-bytes!')
    expect(await recordUploadedFile('img', 'att-up', sha256('up-bytes!'))).toBe(true)
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

  /** Bytes this device uploaded at clock `clock`: its next push carries them. */
  async function uploadHere(bytes: string, clock: VectorClock | null = { dev1: 1 }): Promise<void> {
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
    updateNoteMetadata(asClientDb(data.db), 'img', { clock })
    fs.writeFileSync(abs('Pictures/p.png'), bytes)
    expect(await recordUploadedFile('img', 'att-up', sha256(bytes))).toBe(true)
  }

  /** Note pushes through the real note sync service; resolves the clock of each queued push. */
  function pushThroughNoteSync(): () => VectorClock[] {
    const queue = new SyncQueueManager(asClientDb(data.db))
    const notes = new NoteSyncService({ queue, getDeviceId: () => 'dev1' })
    vi.mocked(enqueueLocalSyncUpdate).mockImplementation((type, itemId) => {
      if (type === 'note') notes.enqueueUpdate(itemId)
    })
    return () =>
      data.db
        .select({ payload: syncQueue.payload })
        .from(syncQueue)
        .all()
        .map((row) => (JSON.parse(row.payload) as NoteSyncPayload).clock as VectorClock)
  }

  it('keeps no conflict copy of uploaded bytes the merged record has seen', async () => {
    await uploadHere('up-bytes!')
    // Pushed at dev1 2, then renamed here at dev1 3.
    updateNoteMetadata(asClientDb(data.db), 'img', { clock: { dev1: 3 } })

    expect(pull('img', 'att-new', { dev1: 2, peer: 1 })).toBe('conflict')
    land('img', 'att-new', abs('Pictures/p.png'), 'peer-bytes')

    expect(read('Pictures/p.png')).toBe('peer-bytes')
    expect(conflictCopies('Pictures')).toEqual([])
  })

  it('keeps uploaded bytes the merged record has not seen as a conflict copy', async () => {
    await uploadHere('up-bytes!')
    // Its push, at dev1 2, is not on the server yet.
    updateNoteMetadata(asClientDb(data.db), 'img', { clock: { dev1: 2 } })

    expect(pull('img', 'att-new', { dev1: 1, peer: 1 })).toBe('conflict')
    land('img', 'att-new', abs('Pictures/p.png'), 'peer-bytes')

    expect(read('Pictures/p.png')).toBe('peer-bytes')
    expect(conflictCopies('Pictures')).toEqual(['up-bytes!'])
  })

  // The upload's tick is the row's as it records, after its hash (REVIEW-5626).
  it('keeps uploaded bytes as a conflict copy when the merged record saw only a push made while they hashed', async () => {
    const answer = holdHashes()
    const uploaded = uploadHere('up-bytes!')
    await vi.waitFor(() => expect(hashing.reads).toBe(1))
    // Renamed here while the bytes hashed, and pushed at dev1 6.
    updateNoteMetadata(asClientDb(data.db), 'img', { clock: { dev1: 6 } })
    answer()
    await uploaded
    // The push that carries the bytes, at dev1 7, is not on the server yet.
    updateNoteMetadata(asClientDb(data.db), 'img', { clock: { dev1: 7 } })
    manifests.set('att-up', sha256('up-bytes!'))

    expect(pull('img', 'att-new', { dev1: 6, peer: 1 })).toBe('conflict')
    await settleBinaryHashCheck('img')
    land('img', 'att-new', abs('Pictures/p.png'), 'peer-bytes')

    expect(read('Pictures/p.png')).toBe('peer-bytes')
    expect(conflictCopies('Pictures')).toEqual(['up-bytes!'])
  })

  // A row with no clock pushes on its tombstone's clock, past every tick the
  // delete holds: the upload's tick is that push's (#5676).
  describe('on a row with only a tombstone clock', () => {
    beforeEach(() => {
      // Deleted here at dev1 5, then back with no clock.
      recordTombstoneClock(asClientDb(data.db), 'note', 'img', { dev1: 5 })
    })

    it('keeps uploaded bytes as a conflict copy when the merged record has not seen their push', async () => {
      const pushed = pushThroughNoteSync()
      await uploadHere('up-bytes!', null)
      expect(pushed()).toEqual([{ dev1: 6 }])

      expect(pull('img', 'att-new', { dev1: 3, peer: 1 })).toBe('conflict')
      land('img', 'att-new', abs('Pictures/p.png'), 'peer-bytes')

      expect(read('Pictures/p.png')).toBe('peer-bytes')
      expect(conflictCopies('Pictures')).toEqual(['up-bytes!'])
    })

    it('keeps no conflict copy when the merged record has seen their push', async () => {
      const pushed = pushThroughNoteSync()
      await uploadHere('up-bytes!', null)
      expect(pushed()).toEqual([{ dev1: 6 }])
      // Renamed here after the push, at dev1 7.
      updateNoteMetadata(asClientDb(data.db), 'img', { clock: { dev1: 7 } })

      expect(pull('img', 'att-new', { dev1: 6, peer: 1 })).toBe('conflict')
      land('img', 'att-new', abs('Pictures/p.png'), 'peer-bytes')

      expect(read('Pictures/p.png')).toBe('peer-bytes')
      expect(conflictCopies('Pictures')).toEqual([])
    })
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

  it("keeps an upload that finishes after the peer's bytes landed off the note", async () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    fs.writeFileSync(abs('Pictures/p.png'), 'local-edit')
    updateNoteMetadata(asClientDb(data.db), 'img', { fileSize: 'local-edit'.length })
    enqueueUpload(asClientDb(data.db), 'img', abs('Pictures/p.png'))
    expect(pull('img', 'att-b')).toBe('applied')
    land('img', 'att-b', abs('Pictures/p.png'), 'b-bytes')
    expect(conflictCopies('Pictures')).toEqual(['local-edit'])

    // The upload of the local edit was in flight; it finishes after the landing.
    expect(await recordUploadedFile('img', 'att-local', sha256('local-edit'))).toBe(false)

    expect(attachmentOf('img')).toBe('att-b')
    expect(enqueueLocalSyncUpdate).not.toHaveBeenCalledWith('note', 'img')
    expect(read('Pictures/p.png')).toBe('b-bytes')
    expect(readSyncedBinaryHash(asClientDb(data.db), 'img')).toBe(sha256('b-bytes'))
  })

  /** Holds every hash, once it read its file, until the returned answer is called. */
  function holdHashes(): () => void {
    let answer = (): void => {}
    hashing.answer = new Promise<void>((release) => {
      answer = release
    })
    return answer
  }

  /** Holds every hash before it opens its file until the returned call. */
  function holdOpens(): () => void {
    let open = (): void => {}
    hashing.open = new Promise<void>((release) => {
      open = release
    })
    return open
  }

  // The hash read the uploaded bytes before the landing renamed others over them (#5617).
  it.each(['b-bytes', 'old-bytes'])(
    "keeps an upload off the note when the peer's bytes (%s) land while its file hashes",
    async (peerBytes) => {
      seed('img', 'Pictures/p.png', 'old-bytes')
      fs.writeFileSync(abs('Pictures/p.png'), 'local-edit')
      updateNoteMetadata(asClientDb(data.db), 'img', { fileSize: 'local-edit'.length })
      enqueueUpload(asClientDb(data.db), 'img', abs('Pictures/p.png'))
      const answer = holdHashes()

      // The upload of the local edit succeeded; its file is hashing.
      const recorded = recordUploadedFile('img', 'att-local', sha256('local-edit'))
      await vi.waitFor(() => expect(hashing.reads).toBe(1))
      expect(pull('img', 'att-b')).toBe('applied')
      land('img', 'att-b', abs('Pictures/p.png'), peerBytes)
      expect(conflictCopies('Pictures')).toEqual(['local-edit'])
      answer()

      expect(await recorded).toBe(false)
      expect(attachmentOf('img')).toBe('att-b')
      expect(enqueueLocalSyncUpdate).not.toHaveBeenCalledWith('note', 'img')
      expect(read('Pictures/p.png')).toBe(peerBytes)
      expect(readSyncedBinaryHash(asClientDb(data.db), 'img')).toBe(sha256(peerBytes))
    }
  )

  it('records the newer of two uploads whose hashes overlap, the file it holds', async () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    fs.writeFileSync(abs('Pictures/p.png'), 'edit-one')
    const answer = holdHashes()

    const first = recordUploadedFile('img', 'att-one', sha256('edit-one'))
    await vi.waitFor(() => expect(hashing.reads).toBe(1))
    fs.writeFileSync(abs('Pictures/p.png'), 'edit-two!')
    const second = recordUploadedFile('img', 'att-two', sha256('edit-two!'))
    await vi.waitFor(() => expect(hashing.reads).toBe(2))
    answer()

    expect(await first).toBe(false)
    expect(await second).toBe(true)
    expect(attachmentOf('img')).toBe('att-two')
    expect(readSyncedBinaryHash(asClientDb(data.db), 'img')).toBe(sha256('edit-two!'))
  })

  // Nothing retries an upload kept off its note: its edit would never sync (#5617).
  describe.each([
    ['while it hashed', holdHashes, () => hashing.reads],
    // The hash opens nothing where the row named the file: no bytes read is no proof.
    ['as its hash opened', holdOpens, () => hashing.opens]
  ])('records an upload whose file moved %s', (_when, hold, held) => {
    async function uploadMovedMidHash(move: () => Promise<unknown>): Promise<boolean> {
      seed('img', 'Pictures/p.png', 'old-bytes')
      fs.writeFileSync(abs('Pictures/p.png'), 'local-edit')
      updateNoteMetadata(asClientDb(data.db), 'img', { fileSize: 'local-edit'.length })
      const release = hold()

      const recorded = recordUploadedFile('img', 'att-local', sha256('local-edit'))
      await vi.waitFor(() => expect(held()).toBe(1))
      await move()
      release()
      return recorded
    }

    function expectRecorded(): void {
      expect(attachmentOf('img')).toBe('att-local')
      expect(enqueueLocalSyncUpdate).toHaveBeenCalledWith('note', 'img')
      expect(readSyncedBinaryHash(asClientDb(data.db), 'img')).toBe(sha256('local-edit'))
    }

    it("by a peer's move", async () => {
      const recorded = uploadMovedMidHash(async () => {
        expect(pull('img', 'att-img', { dev1: 1, peer: 1 }, 'Moved')).toBe('applied')
      })

      expect(await recorded).toBe(true)
      expect(read('Moved/p.png')).toBe('local-edit')
      expectRecorded()
    })

    it('by a rename in the app', async () => {
      const recorded = uploadMovedMidHash(() => renameNote('img', 'renamed'))

      expect(await recorded).toBe(true)
      expect(read('Pictures/renamed.png')).toBe('local-edit')
      expectRecorded()
    })
  })

  // renameNote renames the file before it updates the row (#5617).
  it('records an upload whose row moved while the stat after its hash looked at the old path', async () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    fs.writeFileSync(abs('Pictures/p.png'), 'local-edit')
    const answer = holdHashes()

    const recorded = recordUploadedFile('img', 'att-local', sha256('local-edit'))
    await vi.waitFor(() => expect(hashing.reads).toBe(1))
    fs.mkdirSync(abs('Moved'))
    fs.renameSync(abs('Pictures/p.png'), abs('Moved/p.png'))
    hashing.onStat = (filePath) => {
      if (filePath !== abs('Pictures/p.png')) return
      hashing.onStat = null
      updateNoteMetadata(asClientDb(data.db), 'img', { path: 'Moved/p.png' })
    }
    answer()

    expect(await recorded).toBe(true)
    expect(attachmentOf('img')).toBe('att-local')
    expect(readSyncedBinaryHash(asClientDb(data.db), 'img')).toBe(sha256('local-edit'))
  })

  // The hash's bytes are a no-proof once the file moved: the row's file holds other bytes (#5617).
  it("keeps a late upload off the note when the peer's landed bytes move as its hash opens", async () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    fs.writeFileSync(abs('Pictures/p.png'), 'local-edit')
    updateNoteMetadata(asClientDb(data.db), 'img', { fileSize: 'local-edit'.length })
    enqueueUpload(asClientDb(data.db), 'img', abs('Pictures/p.png'))
    expect(pull('img', 'att-b')).toBe('applied')
    land('img', 'att-b', abs('Pictures/p.png'), 'peer-bytes')
    expect(conflictCopies('Pictures')).toEqual(['local-edit'])
    const open = holdOpens()

    const recorded = recordUploadedFile('img', 'att-local', sha256('local-edit'))
    await vi.waitFor(() => expect(hashing.opens).toBe(1))
    expect(pull('img', 'att-b', { dev1: 1, peer: 2 }, 'Moved')).toBe('applied')
    open()

    expect(await recorded).toBe(false)
    expect(attachmentOf('img')).toBe('att-b')
    expect(enqueueLocalSyncUpdate).not.toHaveBeenCalledWith('note', 'img')
    expect(read('Moved/p.png')).toBe('peer-bytes')
    expect(readSyncedBinaryHash(asClientDb(data.db), 'img')).toBe(sha256('peer-bytes'))
  })

  // Windows refuses to rename a folder the watcher holds a subfolder of, so it
  // moves entry by entry, and its rows follow once every file moved (#2206).
  it("keeps a late upload off the note when the peer's landed bytes move with their folder entry by entry as its hash opens", async () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    fs.writeFileSync(abs('Pictures/p.png'), 'local-edit')
    updateNoteMetadata(asClientDb(data.db), 'img', { fileSize: 'local-edit'.length })
    enqueueUpload(asClientDb(data.db), 'img', abs('Pictures/p.png'))
    expect(pull('img', 'att-b')).toBe('applied')
    land('img', 'att-b', abs('Pictures/p.png'), 'peer-bytes')
    fs.writeFileSync(abs('Pictures/z.png'), 'next entry')
    const open = holdOpens()
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let holding = false
    hashing.onRename = async (from) => {
      if (from === abs('Pictures')) {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      }
      if (from === abs('Pictures/z.png')) {
        holding = true
        await held
      }
    }

    const recorded = recordUploadedFile('img', 'att-local', sha256('local-edit'))
    await vi.waitFor(() => expect(hashing.opens).toBe(1))
    const renamed = renameFolderCommand('Pictures', 'Moved')
    await vi.waitFor(() => expect(holding).toBe(true))
    expect(fs.existsSync(abs('Pictures/p.png'))).toBe(false)
    open()
    await vi.waitFor(() => expect(hashing.reads).toBe(1))
    release()
    await renamed

    expect(await recorded).toBe(false)
    expect(attachmentOf('img')).toBe('att-b')
    expect(read('Moved/p.png')).toBe('peer-bytes')
    expect(readSyncedBinaryHash(asClientDb(data.db), 'img')).toBe(sha256('peer-bytes'))
  })

  it('keeps a late upload off the note when a newer recorded edit is renamed as its hash opens', async () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    fs.writeFileSync(abs('Pictures/p.png'), 'edit-one')
    fs.writeFileSync(abs('Pictures/p.png'), 'edit-two!')
    expect(await recordUploadedFile('img', 'att-two', sha256('edit-two!'))).toBe(true)
    const open = holdOpens()

    const recorded = recordUploadedFile('img', 'att-one', sha256('edit-one'))
    await vi.waitFor(() => expect(hashing.opens).toBe(2))
    await renameNote('img', 'renamed')
    open()

    expect(await recorded).toBe(false)
    expect(attachmentOf('img')).toBe('att-two')
    expect(read('Pictures/renamed.png')).toBe('edit-two!')
    expect(readSyncedBinaryHash(asClientDb(data.db), 'img')).toBe(sha256('edit-two!'))
  })

  // Pulled before the hash, landed while it hashes, the peer's bytes those last synced, on a
  // file whose identity cannot see the landing: only the mark the pull set shows it (#5617).
  it('keeps an upload off the note when its file was held as the upload finished', async () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    fs.writeFileSync(abs('Pictures/p.png'), 'new-bytes')
    const mtime = 1_700_000_000
    fs.utimesSync(abs('Pictures/p.png'), mtime, mtime)
    expect(pull('img', 'att-b')).toBe('applied')
    const answer = holdHashes()
    const hashed = new Promise<void>((resolve) => {
      hashing.onRead = resolve
    })

    const recorded = recordUploadedFile('img', 'att-local', sha256('new-bytes'))
    await Promise.race([hashed, recorded])
    land('img', 'att-b', abs('Pictures/p.png'), 'old-bytes')
    fs.utimesSync(abs('Pictures/p.png'), mtime, mtime)
    answer()

    expect(await recorded).toBe(false)
    expect(attachmentOf('img')).toBe('att-b')
    expect(read('Pictures/p.png')).toBe('old-bytes')
    expect(conflictCopies('Pictures')).toEqual(['new-bytes'])
  })

  // A file whose identity is its path, size and whole-second mtime: an inode-0 filesystem.
  it('keeps an upload off the note when a landing its file identity cannot see happens while it hashes', async () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    fs.writeFileSync(abs('Pictures/p.png'), 'local-edit')
    const mtime = 1_700_000_000
    fs.utimesSync(abs('Pictures/p.png'), mtime, mtime)
    const answer = holdHashes()

    const recorded = recordUploadedFile('img', 'att-local', sha256('local-edit'))
    await vi.waitFor(() => expect(hashing.reads).toBe(1))
    expect(pull('img', 'att-b')).toBe('applied')
    // Same inode, size and mtime: only the bytes changed.
    land('img', 'att-b', abs('Pictures/p.png'), 'peer-bytes')
    fs.utimesSync(abs('Pictures/p.png'), mtime, mtime)
    answer()

    expect(await recorded).toBe(false)
    expect(attachmentOf('img')).toBe('att-b')
    expect(read('Pictures/p.png')).toBe('peer-bytes')
    expect(readSyncedBinaryHash(asClientDb(data.db), 'img')).toBe(sha256('peer-bytes'))
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
