/**
 * A peer replaces an image note's bytes while this device has attachment
 * auto-download off (#5580). The note's file is held for the new bytes, so it
 * is stale and none of its changes sync until they land: that download runs
 * anyway, through the real download-needed handler and re-driver. Every other
 * download still waits.
 *
 * @module sync/item-handlers/note-handler.peer-binary-auto-download-off.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
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
import type { NoteSyncPayload } from '@memry/contracts/sync-payloads'

const server = vi.hoisted(() => ({
  blobs: new Map<string, string>(),
  downloads: [] as string[],
  deps: null as null | {
    beforeFileLands?: (
      filePath: string,
      attachmentId: string,
      sha256: string,
      fileOwnerId?: string
    ) => Promise<string>
  }
}))

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
vi.mock('../../database/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDatabase: vi.fn(),
  getIndexDatabase: vi.fn(),
  isDatabaseInitialized: () => true
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
vi.mock('../../file-text', () => ({ fileTextNoteChanged: vi.fn() }))
vi.mock('../token-manager', () => ({ getValidAccessToken: vi.fn(async () => 'token') }))
vi.mock('../runtime-state', () => ({ getNetworkMonitor: vi.fn(() => null) }))
vi.mock('../../crypto', () => ({
  getDevicePublicKey: vi.fn(),
  getOrInitializeLocalVaultKey: vi.fn(),
  secureCleanup: vi.fn(),
  retrieveKey: vi.fn()
}))
vi.mock('../../agent/storage/vault-id', () => ({ getOrCreateVaultUuid: vi.fn(() => 'vault') }))
// The server: the download lands the blob through the service's `beforeFileLands`.
vi.mock('../attachments', () => ({
  AttachmentTooLargeError: class AttachmentTooLargeError extends Error {},
  AttachmentSyncService: vi.fn().mockImplementation(function AttachmentSyncServiceFake(
    deps: typeof server.deps
  ) {
    server.deps = deps
    return {
      downloadAttachment: async (
        attachmentId: string,
        targetPath: string,
        opts?: { fileOwnerId?: string }
      ) => {
        server.downloads.push(attachmentId)
        const bytes = server.blobs.get(attachmentId) ?? ''
        const checksum = createHash('sha256').update(bytes).digest('hex')
        const filePath =
          (await server.deps?.beforeFileLands?.(
            targetPath,
            attachmentId,
            checksum,
            opts?.fileOwnerId
          )) ?? targetPath
        fs.writeFileSync(filePath, bytes)
        return { filePath, manifest: { checksum } }
      }
    }
  })
}))

import { getDatabase, getIndexDatabase } from '../../database'
import {
  getDatabase as getClientDatabase,
  getIndexDatabase as getClientIndexDatabase
} from '../../database/client'
import { getStatus } from '../../vault/index'
import { setSetting } from '../../database/queries/settings'
import { recordAppWrite } from '../../vault/app-writes'
import { createNoteDerivedStateProjector } from '../../projections/projectors/note-derived-state-projector'
import { startProjectionRuntime, stopProjectionRuntime } from '../../projections'
import { noteHandler } from './note-handler'
import { recordDownloadedFileSize, recordUploadedFile } from '../note-attachment-metadata'
import { redriveAttachmentDownloads } from '../attachment-download-redriver'
import { getValidAccessToken } from '../token-manager'
import {
  registerAttachmentHandlers,
  unregisterAttachmentHandlers
} from '../../ipc/sync-attachment-handlers'
import { resetAttachmentDownloadSession } from '@memry/sync-client/attachment-download-state'

describe("a peer's replacement of a binary note with attachment auto-download off", () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  const abs = (relativePath: string) => path.join(vault.path, relativePath)
  const read = (relativePath: string) => fs.readFileSync(abs(relativePath), 'utf8')
  const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex')

  beforeEach(() => {
    vault = createTestVault('peer-binary-auto-download-off')
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
    setSetting(
      asClientDb(data.db),
      'sync',
      JSON.stringify({ enabled: true, autoSync: true, attachmentAutoDownload: false })
    )
    server.blobs.clear()
    server.downloads.length = 0
    registerAttachmentHandlers()
  })

  afterEach(async () => {
    unregisterAttachmentHandlers()
    await stopProjectionRuntime({ drain: true })
    resetAttachmentDownloadSession()
    index.close()
    data.close()
    vault.cleanup()
    vi.clearAllMocks()
  })

  /** A synced image note with the bytes it last downloaded on disk. */
  function seed(id: string, relativePath: string, bytes: string): void {
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
    recordDownloadedFileSize(id, `att-${id}`, bytes.length, sha256(bytes))
  }

  /** The peer's record for image note `id` naming `attachmentId`, as a pull applies it. */
  function pull(id: string, attachmentId: string, title = 'p') {
    const clock = { dev1: 1, peer: 1 }
    const payload: NoteSyncPayload = {
      title,
      folderPath: 'Pictures',
      fileType: 'image',
      mimeType: 'image/png',
      attachmentId,
      clock,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-13T00:00:00.000Z'
    }
    return noteHandler.applyUpsert({ db: asClientDb(data.db), emit: vi.fn() }, id, payload, clock)
  }

  const noteRow = (id: string) =>
    data.db
      .select()
      .from(noteMetadata)
      .all()
      .find((row) => row.id === id)
  const attachmentOf = (id: string) => noteRow(id)?.attachmentId

  /**
   * The download of `bytes` has landed on note `id`'s file. The bytes are on
   * disk before the note records them, so a test that waits on the file alone
   * edits a note still held, and the landing then runs into the next test.
   */
  async function landed(id: string, relativePath: string, bytes: string): Promise<void> {
    await vi.waitFor(
      () => {
        expect(read(relativePath)).toBe(bytes)
        expect(noteRow(id)?.fileSize).toBe(bytes.length)
      },
      { timeout: 2_000 }
    )
  }

  /** An edit here, uploaded: the note records it only when its file is its own. */
  async function editAndUpload(id: string, relativePath: string, bytes: string): Promise<void> {
    fs.writeFileSync(abs(relativePath), bytes)
    await recordUploadedFile(id, `att-edit-${id}`, sha256(bytes))
  }

  it("lands the peer's bytes, and the note's next edit syncs", async () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    server.blobs.set('att-new', 'peer-bytes')

    expect(pull('img', 'att-new')).toBe('applied')

    await landed('img', 'Pictures/p.png', 'peer-bytes')
    await editAndUpload('img', 'Pictures/p.png', 'edited-after')
    expect(attachmentOf('img')).toBe('att-edit-img')
  })

  it('re-drives the download a pull could not start', async () => {
    seed('img', 'Pictures/p.png', 'old-bytes')
    server.blobs.set('att-new', 'peer-bytes')
    // Signed out for a moment: the pull's request reaches no downloader.
    vi.mocked(getValidAccessToken).mockResolvedValueOnce(null)
    expect(pull('img', 'att-new')).toBe('applied')
    await vi.waitFor(() => expect(getValidAccessToken).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(read('Pictures/p.png')).toBe('old-bytes')

    await redriveAttachmentDownloads()

    await landed('img', 'Pictures/p.png', 'peer-bytes')
  })

  it("leaves a new note's file to download on demand", async () => {
    server.blobs.set('att-fresh', 'fresh-bytes')

    expect(pull('fresh', 'att-fresh', 'fresh')).toBe('applied')
    await redriveAttachmentDownloads()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(server.downloads).toEqual([])
    expect(fs.existsSync(abs('Pictures/fresh.png'))).toBe(false)
  })
})
