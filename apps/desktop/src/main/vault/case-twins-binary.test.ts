/**
 * Two binary notes whose paths differ only in case share one file on a
 * case-insensitive disk, and the file holds one twin's bytes. A change to it
 * is never pushed as either twin's attachment (#5522), and a peer's rename or
 * move of one twin leaves the file with the other (#5560).
 *
 * @module vault/case-twins-binary.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { attachmentEvents } from '@memry/sync-client/attachment-events'
import type { NoteSyncPayload } from '@memry/contracts/sync-payloads'

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
vi.mock('../sync/crdt-provider', () => ({
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
vi.mock('../sync/attachment-backfill', () => ({ queueEmbeddedVaultFiles: vi.fn() }))
vi.mock('../tasks/reconcile-markdown-tasks', () => ({
  reconcileTaskCheckboxesFromMarkdown: vi.fn(async () => 0)
}))
vi.mock('../inbox/suggestions', () => ({ updateNoteEmbedding: vi.fn() }))
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
import { enqueueLocalSyncUpdate } from '../sync/local-mutations'
import { markWritebackIgnored } from '../sync/crdt-writeback'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import {
  flushProjectionEvents,
  startProjectionRuntime,
  stopProjectionRuntime
} from '../projections'
import { clearIngestBackfill, drainIngestBackfill } from './ingest-backfill'
import { clearAllPendingDeletes } from './rename-tracker'
import { startWatcher, stopWatcher } from './watcher'
import { noteHandler } from '../sync/item-handlers/note-handler'
import { redriveAttachmentDownloads } from '../sync/attachment-download-redriver'
import { recordDownloadedFileSize } from '../sync/note-attachment-metadata'
import {
  releaseDownloadAttempt,
  resetAttachmentDownloadSession
} from '@memry/sync-client/attachment-download-state'
import { attachmentDownloadFailures, syncState } from '@memry/db-schema/data-schema'
import { eq } from 'drizzle-orm'

function fileSystemIgnoresCase(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-case-probe-'))
  try {
    fs.writeFileSync(path.join(dir, 'probe'), '')
    return fs.existsSync(path.join(dir, 'PROBE'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe.runIf(fileSystemIgnoresCase())('binary case twins sharing one file', () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  const saved = vi.fn()
  const downloads = vi.fn()
  const onSaved = (event: { noteId: string }) => saved(event.noteId)
  const onDownload = (event: { noteId: string; diskPath: string }) =>
    downloads(event.noteId, event.diskPath)
  const abs = (relativePath: string) => path.join(vault.path, relativePath)

  beforeEach(() => {
    vault = createTestVault('case-twins-binary')
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

  /** A pulled attachment note: its canonical and index rows, and its bytes at the row's spelling. */
  function seed(id: string, relativePath: string, bytes: string): void {
    const fields = {
      id,
      path: relativePath,
      title: path.basename(relativePath, path.extname(relativePath)),
      fileType: 'image' as const,
      mimeType: 'image/png',
      attachmentId: `att-${id}`,
      clock: { dev1: 1 },
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z',
      syncedAt: '2026-01-12T00:00:00.000Z',
      fileSize: bytes.length
    }
    upsertNoteMetadata(asClientDb(data.db), fields)
    insertNoteCache(index.db, { ...fields, contentHash: null })
    const absolutePath = path.join(vault.path, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    markWritebackIgnored(absolutePath)
    fs.writeFileSync(absolutePath, bytes)
  }

  const rows = () =>
    data.db
      .select({ id: noteMetadata.id, path: noteMetadata.path })
      .from(noteMetadata)
      .all()
      .toSorted((a, b) => a.id.localeCompare(b.id))

  const read = (relativePath: string) =>
    fs.readFileSync(path.join(vault.path, relativePath), 'utf8')

  /** Twin A's row spells `Supernotes/`, B's `SUPERNOTES/`; B's bytes are on disk. */
  function twins(diskFolder: 'Supernotes' | 'SUPERNOTES'): void {
    fs.mkdirSync(path.join(vault.path, diskFolder), { recursive: true })
    seed('twin-a', 'Supernotes/p.png', 'a-bytes')
    seed('twin-b', 'SUPERNOTES/p.png', 'b-bytes')
  }

  const pushed = () => ({
    updates: vi.mocked(enqueueLocalSyncUpdate).mock.calls.map(([, id]) => id),
    saved: saved.mock.calls.map(([id]) => id)
  })

  /**
   * Writes `edits` with the watcher running, past the window in which it drops
   * sync's own writes, until the `until` check passes: a note pushed (a
   * control note's edit in the same batch proves the batch was handled).
   */
  async function editUntilPushed(edits: Record<string, string>, until: () => void): Promise<void> {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10_000 })
    try {
      await vi.waitFor(
        async () => {
          for (const [relativePath, bytes] of Object.entries(edits)) {
            fs.writeFileSync(abs(relativePath), bytes)
          }
          await new Promise((resolve) => setTimeout(resolve, 400))
          await flushProjectionEvents()
          until()
        },
        { timeout: 15_000, interval: 100 }
      )
      await drainIngestBackfill()
      await flushProjectionEvents()
    } finally {
      vi.useRealTimers()
    }
  }

  const pushedNote = (id: string) => () => expect(pushed().saved).toContain(id)

  const twinPushes = () => {
    const twin = (id: string) => id.startsWith('twin-')
    return { updates: pushed().updates.filter(twin), saved: pushed().saved.filter(twin) }
  }

  // The row whose spelling matches the disk takes the change event: A's for a
  // `Supernotes/` folder, B's for `SUPERNOTES/`.
  for (const diskFolder of ['Supernotes', 'SUPERNOTES'] as const) {
    it(`an outside edit to the shared file in ${diskFolder}/ pushes neither twin's bytes`, async () => {
      twins(diskFolder)
      seed('control', `${diskFolder}/c.png`, 'c-bytes')
      await startWatcher(vault.path)

      await editUntilPushed(
        { [`${diskFolder}/p.png`]: 'edited', [`${diskFolder}/c.png`]: 'edited' },
        pushedNote('control')
      )

      expect(twinPushes()).toEqual({ updates: [], saved: [] })
      expect(rows().map((row) => row.id)).toEqual(['control', 'twin-a', 'twin-b'])
    }, 30_000)
  }

  /** A peer's record for twin B as a pull applies it: renamed, moved, or both. */
  function applyPeerUpdate(change: { title?: string; folderPath?: string }) {
    const payload: NoteSyncPayload = {
      title: change.title ?? 'p',
      folderPath: change.folderPath ?? 'SUPERNOTES',
      fileType: 'image',
      mimeType: 'image/png',
      attachmentId: 'att-twin-b',
      clock: { dev1: 1, peer: 1 },
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-13T00:00:00.000Z'
    }
    return noteHandler.applyUpsert({ db: asClientDb(data.db), emit: vi.fn() }, 'twin-b', payload, {
      dev1: 1,
      peer: 1
    })
  }

  for (const [how, change, newPath] of [
    ['rename', { title: 'q' }, 'SUPERNOTES/q.png'],
    ['move', { folderPath: 'Other' }, 'Other/p.png']
  ] as const) {
    it(`a peer's ${how} of a binary twin keeps the shared file for the other twin`, () => {
      twins('Supernotes')

      expect(applyPeerUpdate(change)).toBe('applied')

      expect(rows()).toEqual([
        { id: 'twin-a', path: 'Supernotes/p.png' },
        { id: 'twin-b', path: newPath }
      ])
      // The file stays for A; B gets a copy. Either file may hold the other
      // twin's bytes, so each twin's own bytes are asked for.
      expect(read('Supernotes/p.png')).toBe('b-bytes')
      expect(read(newPath)).toBe('b-bytes')
      expect(downloads.mock.calls).toEqual([
        ['twin-b', abs(newPath)],
        ['twin-a', abs('Supernotes/p.png')]
      ])
    })
  }

  const heldChanges = (): unknown =>
    JSON.parse(
      data.db
        .select({ value: syncState.value })
        .from(syncState)
        .where(eq(syncState.key, 'caseTwinHeldChanges'))
        .get()?.value ?? '[]'
    )

  const owed = () =>
    data.db
      .select({ id: attachmentDownloadFailures.id })
      .from(attachmentDownloadFailures)
      .all()
      .map((row) => row.id)
      .toSorted()

  // The downloader drops a request with no token or with auto-download off by
  // releasing it, the same outcome as an emit with no listener.
  const dropRequest = (event: { noteId: string; attachmentId: string }) =>
    releaseDownloadAttempt(event.noteId, event.attachmentId)
  for (const [how, drop] of [
    ['no downloader', null],
    ['a downloader that drops it', dropRequest]
  ] as const) {
    it(`a split twin's own bytes asked for with ${how} are asked for again by the re-driver`, async () => {
      twins('Supernotes')
      attachmentEvents.offDownloadNeeded(onDownload)
      if (drop) attachmentEvents.onDownloadNeeded(drop)
      try {
        expect(applyPeerUpdate({ folderPath: 'Other' })).toBe('applied')
      } finally {
        if (drop) attachmentEvents.offDownloadNeeded(drop)
        attachmentEvents.onDownloadNeeded(onDownload)
      }
      expect(owed()).toEqual(['twin-a::att-twin-a', 'twin-b::att-twin-b'])
      expect(downloads).not.toHaveBeenCalled()

      await redriveAttachmentDownloads()

      expect(downloads.mock.calls.toSorted(([a], [b]) => a.localeCompare(b))).toEqual([
        ['twin-a', abs('Supernotes/p.png')],
        ['twin-b', abs('Other/p.png')]
      ])
    })
  }

  it("an outside edit to a split twin's copy is not pushed until its own bytes land", async () => {
    twins('Supernotes')
    seed('control', 'Other/c.png', 'c-bytes')
    expect(applyPeerUpdate({ folderPath: 'Other' })).toBe('applied')
    await startWatcher(vault.path)

    await editUntilPushed(
      { 'Other/p.png': 'edited', 'Other/c.png': 'edited' },
      pushedNote('control')
    )
    expect(twinPushes()).toEqual({ updates: [], saved: [] })

    recordDownloadedFileSize('twin-b', 'b-bytes'.length)
    await editUntilPushed({ 'Other/p.png': 'edited again' }, pushedNote('twin-b'))
    expect(twinPushes().updates).toContain('twin-b')
  }, 45_000)

  it('a held change to the shared file stays at the split and is not pushed', async () => {
    twins('Supernotes')
    seed('control', 'Supernotes/c.png', 'c-bytes')
    await startWatcher(vault.path)
    // Same size as the bytes the twins recorded: only the held record keeps it.
    await editUntilPushed({ 'Supernotes/p.png': 'h-bytes', 'Supernotes/c.png': 'edited' }, () =>
      expect(heldChanges()).toEqual(['supernotes/p.png'])
    )

    expect(applyPeerUpdate({ folderPath: 'Other' })).toBe('applied')

    expect(read('Supernotes/p.png')).toBe('h-bytes')
    expect(downloads.mock.calls).toEqual([['twin-b', abs('Other/p.png')]])
    saved.mockClear()
    await editUntilPushed(
      { 'Supernotes/p.png': 'edited after the split', 'Supernotes/c.png': 'edited again' },
      pushedNote('control')
    )
    expect(twinPushes()).toEqual({ updates: [], saved: [] })
  }, 45_000)

  it('a change the watcher has not seen stays at the split', () => {
    twins('Supernotes')
    // Written while the app was closed, or with its event still on the way.
    fs.writeFileSync(abs('Supernotes/p.png'), 'edited offline')

    expect(applyPeerUpdate({ folderPath: 'Other' })).toBe('applied')

    expect(read('Supernotes/p.png')).toBe('edited offline')
    expect(downloads.mock.calls).toEqual([['twin-b', abs('Other/p.png')]])
  })

  const applyPeerDelete = (id: string) =>
    noteHandler.applyDelete({ db: asClientDb(data.db), emit: vi.fn() }, id)

  it("a peer's delete of a binary twin asks for the survivor's own bytes onto the file", async () => {
    twins('Supernotes')
    seed('control', 'Supernotes/c.png', 'c-bytes')

    expect(applyPeerDelete('twin-b')).toBe('applied')

    expect(rows().map((row) => row.id)).toEqual(['control', 'twin-a'])
    expect(downloads.mock.calls).toEqual([['twin-a', abs('Supernotes/p.png')]])
    expect(owed()).toEqual(['twin-a::att-twin-a'])
    // Until A's own bytes land, the file may hold B's.
    await startWatcher(vault.path)
    await editUntilPushed(
      { 'Supernotes/p.png': 'edited', 'Supernotes/c.png': 'edited' },
      pushedNote('control')
    )
    expect(twinPushes()).toEqual({ updates: [], saved: [] })
  }, 30_000)

  it('a held change stays when a peer deletes a binary twin, and is not pushed', async () => {
    twins('Supernotes')
    seed('control', 'Supernotes/c.png', 'c-bytes')
    await startWatcher(vault.path)
    await editUntilPushed({ 'Supernotes/p.png': 'h-bytes', 'Supernotes/c.png': 'edited' }, () =>
      expect(heldChanges()).toEqual(['supernotes/p.png'])
    )

    expect(applyPeerDelete('twin-b')).toBe('applied')

    expect(read('Supernotes/p.png')).toBe('h-bytes')
    expect(downloads).not.toHaveBeenCalled()
    saved.mockClear()
    await editUntilPushed(
      { 'Supernotes/p.png': 'edited after the delete', 'Supernotes/c.png': 'edited again' },
      pushedNote('control')
    )
    expect(twinPushes()).toEqual({ updates: [], saved: [] })
  }, 45_000)

  it("a peer's move of a binary twin that cannot land changes nothing", () => {
    twins('Supernotes')
    // A file where the new folder goes: the copy cannot be written.
    fs.writeFileSync(path.join(vault.path, 'Other'), 'not a folder')

    expect(() => applyPeerUpdate({ folderPath: 'Other' })).toThrow(/EEXIST|ENOTDIR/)

    expect(rows()).toEqual([
      { id: 'twin-a', path: 'Supernotes/p.png' },
      { id: 'twin-b', path: 'SUPERNOTES/p.png' }
    ])
    expect(read('Supernotes/p.png')).toBe('b-bytes')
    expect(downloads).not.toHaveBeenCalled()
  })
})
