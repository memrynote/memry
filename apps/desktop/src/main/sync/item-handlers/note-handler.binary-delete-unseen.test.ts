/**
 * A peer deletes an image, PDF, audio or video note while this device's file
 * holds bytes no server has: a replace made outside the app while it was
 * closed, or inside the watcher's debounce (#5803). The pull keeps those bytes
 * as a new file beside the note's, and unlinks the note's file.
 *
 * @module sync/item-handlers/note-handler.binary-delete-unseen.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createTestVault } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { getNoteCacheById, getNoteCacheByPath, insertNoteCache } from '@main/database/queries/notes'
import { getNoteMetadataById, upsertNoteMetadata } from '@memry/storage-data'
import { attachmentEvents } from '@memry/sync-client/attachment-events'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
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
import { clearIngestBackfill } from '../../vault/ingest-backfill'
import { clearAllPendingDeletes } from '../../vault/rename-tracker'
import { startWatcher, stopWatcher } from '../../vault/watcher'
import { noteHandler } from './note-handler'
import { recordDownloadedFileSize, recordUploadedFile } from '../note-attachment-metadata'
import { enqueueUpload } from '../attachment-outbox'

const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex')

describe("a peer's delete of a binary note whose file holds bytes no server has", () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  const saved = vi.fn()
  const onSaved = (event: { noteId: string; diskPath: string }) =>
    saved(event.noteId, event.diskPath)
  const abs = (relativePath: string) => path.join(vault.path, relativePath)
  const KEPT = 'Pictures/p (kept from deleted note).png'

  beforeEach(() => {
    vault = createTestVault('binary-delete-unseen')
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
  })

  afterEach(async () => {
    attachmentEvents.offSaved(onSaved)
    await stopWatcher()
    await stopProjectionRuntime({ drain: true })
    clearIngestBackfill()
    clearAllPendingDeletes()
    index.close()
    data.close()
    vault.cleanup()
    vi.clearAllMocks()
  })

  /**
   * A synced image note: its canonical and index rows, and the bytes it last
   * downloaded on disk. `landed` false: a note last synced before #5603,
   * which recorded no hash, indexed after its file was written.
   */
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
    fs.mkdirSync(path.dirname(abs(relativePath)), { recursive: true })
    const written = recordAppWrite(abs(relativePath), bytes)
    fs.writeFileSync(abs(relativePath), bytes)
    written()
    upsertNoteMetadata(asClientDb(data.db), fields)
    insertNoteCache(index.db, { ...fields, contentHash: null })
    if (landed) recordDownloadedFileSize(id, `att-${id}`, bytes.length, sha256(bytes))
  }

  const replaceOutside = (relativePath: string, bytes: string) =>
    fs.writeFileSync(abs(relativePath), bytes)

  /** The peer's tombstone for note `id`, as a pull applies it. */
  const pullDelete = (id: string, clock: VectorClock = { dev1: 1, peer: 1 }) =>
    noteHandler.applyDelete({ db: asClientDb(data.db), emit: vi.fn() }, id, clock)

  const keptCopies = () =>
    fs
      .readdirSync(abs('Pictures'))
      .filter((name) => name.includes('(kept from deleted note)'))
      .map((name) => fs.readFileSync(path.join(abs('Pictures'), name), 'utf8'))

  it('keeps a replace made while the app was closed as a new file', () => {
    seed('img', 'Pictures/p.png', 'synced-bytes')
    replaceOutside('Pictures/p.png', 'replaced while closed')

    expect(pullDelete('img')).toBe('applied')

    expect(keptCopies()).toEqual(['replaced while closed'])
    expect(fs.existsSync(abs('Pictures/p.png'))).toBe(false)
    expect(getNoteMetadataById(asClientDb(data.db), 'img')).toBeUndefined()
  })

  it('keeps a replace inside the watcher window, which the vault takes in as a new note', async () => {
    seed('img', 'Pictures/p.png', 'synced-bytes')
    await startWatcher(vault.path)

    replaceOutside('Pictures/p.png', 'replaced just now')
    expect(pullDelete('img')).toBe('applied')

    expect(keptCopies()).toEqual(['replaced just now'])
    expect(fs.existsSync(abs('Pictures/p.png'))).toBe(false)
    await vi.waitFor(
      async () => {
        await flushProjectionEvents()
        const kept = getNoteCacheByPath(index.db, KEPT)
        expect(kept?.id).toBeDefined()
        expect(kept?.id).not.toBe('img')
        expect(saved).toHaveBeenCalledWith(kept?.id, abs(KEPT))
      },
      { timeout: 15_000, interval: 100 }
    )
  }, 30_000)

  it('deletes a file that still holds the bytes a download landed', () => {
    seed('img', 'Pictures/p.png', 'synced-bytes')

    expect(pullDelete('img')).toBe('applied')

    expect(keptCopies()).toEqual([])
    expect(fs.existsSync(abs('Pictures/p.png'))).toBe(false)
  })

  /** This device uploads a replace of note `id`'s file; its push carries tick dev1: 2. */
  async function uploadReplace(id: string, bytes: string): Promise<void> {
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
    replaceOutside('Pictures/p.png', bytes)
    expect(await recordUploadedFile(id, 'att-up', sha256(bytes))).toBe(true)
  }

  it('deletes bytes this device uploaded once the tombstone saw their push', async () => {
    seed('img', 'Pictures/p.png', 'synced-bytes')
    await uploadReplace('img', 'uploaded-bytes')

    expect(pullDelete('img', { dev1: 2, peer: 1 })).toBe('applied')

    expect(keptCopies()).toEqual([])
    expect(fs.existsSync(abs('Pictures/p.png'))).toBe(false)
  })

  it('keeps bytes this device uploaded that the tombstone never saw', async () => {
    seed('img', 'Pictures/p.png', 'synced-bytes')
    await uploadReplace('img', 'uploaded-bytes')

    expect(pullDelete('img', { dev1: 1, peer: 1 })).toBe('applied')

    expect(keptCopies()).toEqual(['uploaded-bytes'])
  })

  it('keeps a replace whose upload is pending', () => {
    seed('img', 'Pictures/p.png', 'synced-bytes', false)
    replaceOutside('Pictures/p.png', 'uploading')
    // The watcher read the replace: the index row is fresh, the upload queued.
    insertNoteCache(index.db, { ...getNoteCacheById(index.db, 'img')!, contentHash: null })
    enqueueUpload(asClientDb(data.db), 'img', abs('Pictures/p.png'))

    expect(pullDelete('img')).toBe('applied')

    expect(keptCopies()).toEqual(['uploading'])
  })

  describe('of a note with no synced hash recorded (before #5603)', () => {
    it('deletes a file unchanged since it was indexed', () => {
      seed('img', 'Pictures/p.png', 'synced-bytes', false)

      expect(pullDelete('img')).toBe('applied')

      expect(keptCopies()).toEqual([])
      expect(fs.existsSync(abs('Pictures/p.png'))).toBe(false)
    })

    it('keeps a file changed since it was indexed', () => {
      seed('img', 'Pictures/p.png', 'synced-bytes', false)
      const later = new Date(Date.now() + 5_000)
      replaceOutside('Pictures/p.png', 'replaced while closed')
      fs.utimesSync(abs('Pictures/p.png'), later, later)

      expect(pullDelete('img')).toBe('applied')

      expect(keptCopies()).toEqual(['replaced while closed'])
    })
  })

  it('makes one copy when a rolled-back page applies the delete again', () => {
    seed('img', 'Pictures/p.png', 'synced-bytes')
    replaceOutside('Pictures/p.png', 'replaced while closed')
    const row = getNoteMetadataById(asClientDb(data.db), 'img')!
    const cached = getNoteCacheById(index.db, 'img')!
    // The page's unlink is deferred until it commits; a rollback leaves the file.
    const bytes = fs.readFileSync(abs('Pictures/p.png'))
    expect(pullDelete('img')).toBe('applied')
    fs.writeFileSync(abs('Pictures/p.png'), bytes)
    upsertNoteMetadata(asClientDb(data.db), row)
    insertNoteCache(index.db, cached)
    recordDownloadedFileSize('img', 'att-img', 'synced-bytes'.length, sha256('synced-bytes'))

    expect(pullDelete('img')).toBe('applied')

    expect(keptCopies()).toEqual(['replaced while closed'])
  })

  it("leaves an attachment-store row's file alone", () => {
    seed('img', 'attachments/img/p.png', 'synced-bytes')
    replaceOutside('attachments/img/p.png', 'replaced while closed')

    expect(pullDelete('img')).toBe('applied')

    expect(fs.readFileSync(abs('attachments/img/p.png'), 'utf8')).toBe('replaced while closed')
    expect(fs.readdirSync(abs('attachments/img'))).toEqual(['p.png'])
  })
})
