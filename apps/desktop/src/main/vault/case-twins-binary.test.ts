/**
 * Two binary notes whose paths differ only in case share one file on a
 * case-insensitive disk, and the file holds one twin's bytes. A change to it
 * is never pushed as either twin's attachment (#5522), and a peer's rename or
 * move of one twin leaves the file with the other (#5560). After such a split,
 * a file that may hold the other twin's bytes is not pushed until its own
 * bytes land, and a change made to it is kept as a conflict copy.
 *
 * @module vault/case-twins-binary.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { createTestVault } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { insertNoteCache } from '@main/database/queries/notes'
import { upsertNoteMetadata } from '@memry/storage-data'
import {
  attachmentEvents,
  type AttachmentDownloadNeededEvent
} from '@memry/sync-client/attachment-events'
import type { NoteSyncPayload } from '@memry/contracts/sync-payloads'
import type * as AttachmentBackfill from '../sync/attachment-backfill'

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
    purge: vi.fn(async () => {}),
    initPersistence: vi.fn(async () => {})
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
  isDatabaseInitialized: () => true,
  getDatabase: vi.fn(),
  getIndexDatabase: vi.fn()
}))
// Sign-out's session side: keychain, runtime, tokens and the calendar runner.
vi.mock('../crypto', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deleteKey: vi.fn(async () => {})
}))
vi.mock('../sync/runtime', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stopSyncRuntime: vi.fn(async () => {})
}))
vi.mock('../sync/token-manager', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetTokenManagerState: vi.fn(),
  getValidAccessToken: vi.fn(async () => null)
}))
vi.mock('../calendar/google/google-sync-runner', () => ({
  startGoogleCalendarSyncRunner: vi.fn(async () => {}),
  stopGoogleCalendarSyncRunner: vi.fn()
}))

import { getDatabase, getIndexDatabase } from '../database'
import {
  getDatabase as getClientDatabase,
  getIndexDatabase as getClientIndexDatabase
} from '../database/client'
import { getStatus } from './index'
import { enqueueLocalSyncUpdate } from '../sync/local-mutations'
import { recordAppWrite } from './app-writes'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import {
  flushProjectionEvents,
  startProjectionRuntime,
  stopProjectionRuntime
} from '../projections'
import { clearIngestBackfill, drainIngestBackfill } from './ingest-backfill'
import { clearAllPendingDeletes } from './rename-tracker'
import { getWatcher, startWatcher, stopWatcher } from './watcher'
import { releaseAbandonedCaseTwinBytes } from './case-twin-file'
import { landCaseTwinDownload } from './case-twin-landing'
import { holdsBinaryChange } from './case-twin-hold'
import { noteHandler } from '../sync/item-handlers/note-handler'
import { redriveAttachmentDownloads } from '../sync/attachment-download-redriver'
import { recordDownloadedFileSize } from '../sync/note-attachment-metadata'
import { SupersededDownloadError } from '../sync/attachment-errors'
import { readSyncedBinaryHash } from '../sync/binary-synced-hash'
import { listCaseTwinForeignBytes } from './case-twin-bytes'
import { listPendingUploads } from '../sync/attachment-outbox'
import {
  MISSING_PROBE_LIMIT,
  markDownloadFailed,
  releaseDownloadAttempt,
  resetAttachmentDownloadSession
} from '@memry/sync-client/attachment-download-state'
import { attachmentDownloadFailures, syncState } from '@memry/db-schema/data-schema'
import { teardownSession } from '../sync/session-teardown'
import { bindVaultForSync } from '../sync/vault-account-binding'
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
  const asked = vi.fn()
  const onSaved = (event: { noteId: string }) => saved(event.noteId)
  const onDownload = (event: { noteId: string; attachmentId: string; diskPath: string }) => {
    downloads(event.noteId, event.diskPath)
    asked(event.attachmentId)
  }
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

  interface Own {
    attachmentId?: string | null
    localOnly?: boolean
  }

  /** A pulled attachment note: its canonical and index rows, and its bytes at the row's spelling. */
  function seed(id: string, relativePath: string, bytes: string, own: Own = {}): void {
    const fields = {
      id,
      path: relativePath,
      title: path.basename(relativePath, path.extname(relativePath)),
      fileType: 'image' as const,
      mimeType: 'image/png',
      attachmentId: own.attachmentId === undefined ? `att-${id}` : own.attachmentId,
      localOnly: own.localOnly ?? false,
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
    const landed = recordAppWrite(absolutePath, bytes)
    fs.writeFileSync(absolutePath, bytes)
    landed()
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
  function twins(diskFolder: 'Supernotes' | 'SUPERNOTES', a: Own = {}, b: Own = {}): void {
    fs.mkdirSync(path.join(vault.path, diskFolder), { recursive: true })
    seed('twin-a', 'Supernotes/p.png', 'a-bytes', a)
    seed('twin-b', 'SUPERNOTES/p.png', 'b-bytes', b)
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

  const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex')

  /** A download of note `id`'s attachment, asked for at `requestedPath`, as the downloader lands it. */
  function land(id: string, attachmentId: string, requestedPath: string, bytes: string): string {
    const at = landCaseTwinDownload(requestedPath, attachmentId, sha256(bytes), id)
    // The downloader records the verified file's hash and never reports it landed.
    recordAppWrite(at, { sha256: sha256(bytes) })
    fs.writeFileSync(at, bytes)
    recordDownloadedFileSize(id, attachmentId, bytes.length, sha256(bytes))
    return at
  }

  const conflictCopies = (folder: string) =>
    fs.readdirSync(abs(folder)).filter((name) => name.includes('(conflict copy)'))

  /** Waits until the watcher takes a conflict copy in as a new note and pushes it. */
  async function copyPushed(relativePath: string): Promise<void> {
    await vi.waitFor(
      () => {
        const copy = rows().find((row) => row.path === relativePath)
        expect(copy).toBeDefined()
        expect(pushed().saved).toContain(copy?.id)
      },
      { timeout: 15_000, interval: 100 }
    )
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

  /** A peer's record for a twin as a pull applies it (B by default): renamed, moved, or both. */
  function applyPeerUpdate(change: {
    id?: 'twin-a' | 'twin-b'
    title?: string
    folderPath?: string
    attachmentId?: string | null
  }) {
    const id = change.id ?? 'twin-b'
    const payload: NoteSyncPayload = {
      title: change.title ?? 'p',
      folderPath: change.folderPath ?? (id === 'twin-b' ? 'SUPERNOTES' : 'Supernotes'),
      fileType: 'image',
      mimeType: 'image/png',
      ...(change.attachmentId === null ? {} : { attachmentId: change.attachmentId ?? `att-${id}` }),
      clock: { dev1: 1, peer: 1 },
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-13T00:00:00.000Z'
    }
    return noteHandler.applyUpsert({ db: asClientDb(data.db), emit: vi.fn() }, id, payload, {
      dev1: 1,
      peer: 1
    })
  }

  const applyPeerDelete = (id: string) =>
    noteHandler.applyDelete({ db: asClientDb(data.db), emit: vi.fn() }, id)

  for (const [how, change, newPath] of [
    ['rename', { title: 'q' }, 'SUPERNOTES/q.png'],
    ['move', { folderPath: 'Other' }, 'Other/p.png']
  ] as const) {
    it(`a peer's ${how} of a binary twin keeps the shared file for the other twin`, () => {
      twins('Supernotes')
      // B's bytes landed on the shared file: the split knows them.
      land('twin-b', 'att-twin-b', abs('SUPERNOTES/p.png'), 'b-bytes')

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

      // Bytes nobody changed since the split are on the server: no copy is kept.
      land('twin-b', 'att-twin-b', abs(newPath), 'b-bytes')
      land('twin-a', 'att-twin-a', abs('Supernotes/p.png'), 'a-bytes')
      expect(read('Supernotes/p.png')).toBe('a-bytes')
      expect(read(newPath)).toBe('b-bytes')
      expect([...conflictCopies('Supernotes'), ...conflictCopies(path.dirname(newPath))]).toEqual(
        []
      )
    })
  }

  // With the disk spelling the leaver's folder, an event on the file finds no
  // row at its path and adopts the survivor's row under the disk's spelling.
  for (const [how, split] of [
    ['move', () => applyPeerUpdate({ folderPath: 'Other' })],
    ['delete', () => applyPeerDelete('twin-b')]
  ] as const) {
    it(`after a peer's ${how}, an edit to the file spelled as the leaver's folder is not pushed`, async () => {
      twins('SUPERNOTES')
      seed('control', 'SUPERNOTES/c.png', 'c-bytes')
      expect(split()).toBe('applied')
      await startWatcher(vault.path)

      await editUntilPushed(
        { 'SUPERNOTES/p.png': 'edited', 'SUPERNOTES/c.png': 'edited' },
        pushedNote('control')
      )

      expect(twinPushes()).toEqual({ updates: [], saved: [] })
    }, 30_000)
  }

  // The hold describes this device's file, not the session: a sign-out keeps
  // it, so after the next sign-in the file still waits for its own bytes (#5754).
  it("after a peer's move, an edit to the shared file is not pushed across a sign-out and sign-in", async () => {
    twins('SUPERNOTES')
    seed('control', 'SUPERNOTES/c.png', 'c-bytes')
    expect(applyPeerUpdate({ folderPath: 'Other' })).toBe('applied')

    await teardownSession('logout')
    bindVaultForSync(asClientDb(data.db), 'user-1')
    await startWatcher(vault.path)

    await editUntilPushed(
      { 'SUPERNOTES/p.png': 'edited', 'SUPERNOTES/c.png': 'edited' },
      pushedNote('control')
    )

    expect(twinPushes()).toEqual({ updates: [], saved: [] })
  }, 30_000)

  it("an edit to a split twin's file whose index row lags is not pushed", async () => {
    twins('Supernotes')
    seed('control', 'Supernotes/c.png', 'c-bytes')
    expect(applyPeerUpdate({ folderPath: 'Other' })).toBe('applied')
    // The index is derived and can trail its canonical row: the add path then
    // claims the canonical row's id for the file.
    index.db.delete(noteCache).where(eq(noteCache.id, 'twin-a')).run()
    await startWatcher(vault.path)

    await editUntilPushed(
      { 'Supernotes/p.png': 'edited', 'Supernotes/c.png': 'edited' },
      pushedNote('control')
    )

    expect(twinPushes()).toEqual({ updates: [], saved: [] })
  }, 30_000)

  const heldChanges = (): unknown =>
    JSON.parse(
      data.db
        .select({ value: syncState.value })
        .from(syncState)
        .where(eq(syncState.key, 'caseTwinHeldChanges'))
        .get()?.value ?? '[]'
    )

  const landedHashes = (): unknown =>
    JSON.parse(
      data.db
        .select({ value: syncState.value })
        .from(syncState)
        .where(eq(syncState.key, 'caseTwinLandedHashes'))
        .get()?.value ?? '{}'
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
  const dropRequest = (event: AttachmentDownloadNeededEvent) => releaseDownloadAttempt(event.claim)
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

  it("a download asked for at a split twin's old path lands at its new one", () => {
    twins('Supernotes')
    expect(applyPeerUpdate({ folderPath: 'Other' })).toBe('applied')

    // B's download asked for before the split targets the shared file.
    expect(land('twin-b', 'att-twin-b', abs('SUPERNOTES/p.png'), 'b-own')).toBe(abs('Other/p.png'))

    expect(read('Other/p.png')).toBe('b-own')
    expect(read('Supernotes/p.png')).toBe('b-bytes')
  })

  it("an edit to a split twin's copy is not pushed, and is kept as a conflict copy when its bytes land", async () => {
    twins('Supernotes')
    seed('control', 'Other/c.png', 'c-bytes')
    expect(applyPeerUpdate({ folderPath: 'Other' })).toBe('applied')
    await startWatcher(vault.path)

    await editUntilPushed(
      { 'Other/p.png': 'edited', 'Other/c.png': 'edited' },
      pushedNote('control')
    )
    expect(twinPushes()).toEqual({ updates: [], saved: [] })

    land('twin-b', 'att-twin-b', abs('Other/p.png'), 'b-bytes')
    expect(read('Other/p.png')).toBe('b-bytes')
    expect(read('Other/p (conflict copy).png')).toBe('edited')
    await copyPushed('Other/p (conflict copy).png')

    await editUntilPushed({ 'Other/p.png': 'edited again' }, pushedNote('twin-b'))
    expect(twinPushes().updates).toContain('twin-b')
  }, 60_000)

  it("a held change to the shared file is kept as a conflict copy when the survivor's bytes land", async () => {
    twins('Supernotes')
    seed('control', 'Supernotes/c.png', 'c-bytes')
    await startWatcher(vault.path)
    // Same size as the bytes the twins recorded: only the held record keeps it.
    await editUntilPushed({ 'Supernotes/p.png': 'h-bytes', 'Supernotes/c.png': 'edited' }, () =>
      expect(heldChanges()).toEqual(['supernotes/p.png'])
    )

    expect(applyPeerUpdate({ folderPath: 'Other' })).toBe('applied')

    expect(read('Supernotes/p.png')).toBe('h-bytes')
    expect(downloads.mock.calls).toEqual([
      ['twin-b', abs('Other/p.png')],
      ['twin-a', abs('Supernotes/p.png')]
    ])
    saved.mockClear()
    await editUntilPushed({ 'Supernotes/c.png': 'edited again' }, pushedNote('control'))
    expect(twinPushes()).toEqual({ updates: [], saved: [] })

    land('twin-a', 'att-twin-a', abs('Supernotes/p.png'), 'a-bytes')
    expect(read('Supernotes/p.png')).toBe('a-bytes')
    expect(read('Supernotes/p (conflict copy).png')).toBe('h-bytes')
    await copyPushed('Supernotes/p (conflict copy).png')
  }, 60_000)

  // #5624: a landing is marked by the twin's spelling, and the watcher asks by
  // the disk's. Taken as an outside change, the landing was held, and the next
  // split kept the landed bytes as a conflict copy.
  it("a download landing under a twin's spelling is not held as a change to the shared file", async () => {
    twins('SUPERNOTES')
    await startWatcher(vault.path)
    // Past the window of the seeds' own writes.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10_000 })
    try {
      land('twin-a', 'att-twin-a', abs('Supernotes/p.png'), 'a2-bytes')
      await getWatcher()['handleFileChange'](abs('SUPERNOTES/p.png'))
    } finally {
      vi.useRealTimers()
    }

    expect(heldChanges()).toEqual([])
  }, 30_000)

  it('a change the watcher has not seen is kept as a conflict copy when the bytes land', () => {
    twins('Supernotes')
    // Written while the app was closed, or with its event still on the way.
    fs.writeFileSync(abs('Supernotes/p.png'), 'edited offline')

    expect(applyPeerUpdate({ folderPath: 'Other' })).toBe('applied')

    expect(read('Supernotes/p.png')).toBe('edited offline')
    expect(downloads.mock.calls).toEqual([
      ['twin-b', abs('Other/p.png')],
      ['twin-a', abs('Supernotes/p.png')]
    ])
    land('twin-a', 'att-twin-a', abs('Supernotes/p.png'), 'a-bytes')
    expect(read('Supernotes/p (conflict copy).png')).toBe('edited offline')
    expect(read('Supernotes/p.png')).toBe('a-bytes')
  })

  const foreignMark = (noteId: string): unknown =>
    JSON.parse(
      data.db
        .select({ value: syncState.value })
        .from(syncState)
        .where(eq(syncState.key, `caseTwinForeignBytes:${noteId}`))
        .get()?.value ?? '"no mark"'
    )

  it('a change whose event arrives after the split is kept as a conflict copy', async () => {
    twins('Supernotes')
    seed('control', 'Supernotes/c.png', 'c-bytes')
    land('twin-b', 'att-twin-b', abs('SUPERNOTES/p.png'), 'b-bytes')
    await startWatcher(vault.path)
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10_000 })
    try {
      // The size both twins recorded, and its event still on the way at the split.
      fs.writeFileSync(abs('Supernotes/p.png'), 'h-bytes')
      expect(applyPeerUpdate({ folderPath: 'Other' })).toBe('applied')
      expect(foreignMark('twin-a')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
    await editUntilPushed({ 'Supernotes/c.png': 'edited' }, pushedNote('control'))
    expect(twinPushes()).toEqual({ updates: [], saved: [] })

    land('twin-a', 'att-twin-a', abs('Supernotes/p.png'), 'a-bytes')
    expect(read('Supernotes/p (conflict copy).png')).toBe('h-bytes')
  }, 30_000)

  it("a peer's update to a split twin asks for its new attachment onto its file", () => {
    twins('Supernotes')
    expect(applyPeerUpdate({ folderPath: 'Other' })).toBe('applied')
    downloads.mockClear()
    asked.mockClear()

    expect(applyPeerUpdate({ id: 'twin-a', attachmentId: 'att-a2' })).toBe('applied')

    expect(downloads.mock.calls).toEqual([['twin-a', abs('Supernotes/p.png')]])
    expect(asked.mock.calls).toEqual([['att-a2']])
  })

  // Nothing else holds the bytes of a twin with no attachment or kept local
  // only: its file is the best copy there is, and stays pushable.
  for (const [how, own] of [
    ['with no attachment', { attachmentId: null }],
    ['kept local only', { localOnly: true }]
  ] as const) {
    it(`a split twin ${how} keeps its file pushable`, async () => {
      twins('Supernotes', own)
      seed('control', 'Supernotes/c.png', 'c-bytes')
      expect(applyPeerUpdate({ folderPath: 'Other' })).toBe('applied')
      expect(downloads.mock.calls).toEqual([['twin-b', abs('Other/p.png')]])
      await startWatcher(vault.path)

      await editUntilPushed(
        { 'Supernotes/p.png': 'edited', 'Supernotes/c.png': 'edited' },
        pushedNote('twin-a')
      )
    }, 30_000)
  }

  it('a moved twin with no attachment keeps its copy pushable', async () => {
    twins('Supernotes', {}, { attachmentId: null })
    seed('control', 'Other/c.png', 'c-bytes')
    expect(applyPeerUpdate({ folderPath: 'Other', attachmentId: null })).toBe('applied')
    expect(downloads.mock.calls).toEqual([['twin-a', abs('Supernotes/p.png')]])
    await startWatcher(vault.path)

    await editUntilPushed(
      { 'Other/p.png': 'edited', 'Other/c.png': 'edited' },
      pushedNote('twin-b')
    )
  }, 30_000)

  /** The server answers A's own attachment as gone on every probe: it is never asked for again. */
  const abandonA = () => {
    for (let i = 0; i < MISSING_PROBE_LIMIT; i++) {
      const gone = Object.assign(new Error('Not found'), { statusCode: 404 })
      markDownloadFailed(asClientDb(data.db), 'twin-a', 'att-twin-a', gone)
    }
  }

  it('a split twin whose attachment the server no longer has keeps its file pushable', async () => {
    twins('Supernotes')
    seed('control', 'Supernotes/c.png', 'c-bytes')
    abandonA()
    expect(applyPeerUpdate({ folderPath: 'Other' })).toBe('applied')
    await startWatcher(vault.path)

    await editUntilPushed(
      { 'Supernotes/p.png': 'edited', 'Supernotes/c.png': 'edited' },
      pushedNote('twin-a')
    )
  }, 30_000)

  it('a split twin is released when the server gives up on its own attachment', async () => {
    twins('Supernotes')
    seed('control', 'Supernotes/c.png', 'c-bytes')
    expect(applyPeerUpdate({ folderPath: 'Other' })).toBe('applied')
    // What the downloader records for each failed probe of A's bytes.
    abandonA()
    releaseAbandonedCaseTwinBytes(asClientDb(data.db), 'twin-a', 'att-twin-a')
    await startWatcher(vault.path)

    await editUntilPushed(
      { 'Supernotes/p.png': 'edited', 'Supernotes/c.png': 'edited' },
      pushedNote('twin-a')
    )
  }, 30_000)

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

  it('a held change is kept as a conflict copy when a peer deletes a binary twin', async () => {
    twins('Supernotes')
    seed('control', 'Supernotes/c.png', 'c-bytes')
    await startWatcher(vault.path)
    await editUntilPushed({ 'Supernotes/p.png': 'h-bytes', 'Supernotes/c.png': 'edited' }, () =>
      expect(heldChanges()).toEqual(['supernotes/p.png'])
    )

    expect(applyPeerDelete('twin-b')).toBe('applied')

    expect(read('Supernotes/p.png')).toBe('h-bytes')
    expect(downloads.mock.calls).toEqual([['twin-a', abs('Supernotes/p.png')]])
    land('twin-a', 'att-twin-a', abs('Supernotes/p.png'), 'a-bytes')
    expect(read('Supernotes/p (conflict copy).png')).toBe('h-bytes')
    expect(read('Supernotes/p.png')).toBe('a-bytes')
  }, 45_000)

  // VERIFY-5563R2 #3: an edit made while the app was closed, the size both twins recorded.
  for (const [how, split] of [
    ['move', () => applyPeerUpdate({ folderPath: 'Other' })],
    ['delete', () => applyPeerDelete('twin-b')]
  ] as const) {
    it(`a same-size edit made while the app was closed is kept as a conflict copy at a peer's ${how}`, () => {
      twins('Supernotes')
      land('twin-b', 'att-twin-b', abs('SUPERNOTES/p.png'), 'b-bytes')
      fs.writeFileSync(abs('Supernotes/p.png'), 'x-bytes')

      expect(split()).toBe('applied')
      land('twin-a', 'att-twin-a', abs('Supernotes/p.png'), 'a-bytes')

      expect(read('Supernotes/p.png')).toBe('a-bytes')
      expect(read('Supernotes/p (conflict copy).png')).toBe('x-bytes')
    })
  }

  it("a split with no change since a twin's bytes landed keeps no conflict copy", () => {
    twins('Supernotes')
    land('twin-b', 'att-twin-b', abs('SUPERNOTES/p.png'), 'b-bytes')

    expect(applyPeerDelete('twin-b')).toBe('applied')
    land('twin-a', 'att-twin-a', abs('Supernotes/p.png'), 'a-bytes')

    expect(conflictCopies('Supernotes')).toEqual([])
  })

  it('a survivor whose file already holds its own bytes keeps no conflict copy', () => {
    // No landing recorded: the file's bytes are unknown until the survivor's land.
    twins('Supernotes')

    expect(applyPeerDelete('twin-a')).toBe('applied')
    land('twin-b', 'att-twin-b', abs('SUPERNOTES/p.png'), 'b-bytes')

    expect(conflictCopies('Supernotes')).toEqual([])
  })

  // REVIEW-5591 #10: a twin's new attachment landing on the file while it is still shared.
  for (const [how, landedBefore] of [
    ['after its last landing', true],
    ['with no landing recorded', false]
  ] as const) {
    it(`an offline edit to a still-shared file is kept as a conflict copy when a twin's new bytes land ${how}`, () => {
      twins('Supernotes')
      if (landedBefore) land('twin-b', 'att-twin-b', abs('SUPERNOTES/p.png'), 'b-bytes')
      fs.writeFileSync(abs('Supernotes/p.png'), 'edited offline')
      expect(applyPeerUpdate({ attachmentId: 'att-b2' })).toBe('applied')

      land('twin-b', 'att-b2', abs('SUPERNOTES/p.png'), 'b-new')

      expect(read('Supernotes/p.png')).toBe('b-new')
      expect(conflictCopies('Supernotes')).toEqual(['p (conflict copy).png'])
      expect(read('Supernotes/p (conflict copy).png')).toBe('edited offline')
    })
  }

  it("a twin's new bytes landing on a still-shared file with no change since its last landing keep no conflict copy", () => {
    twins('Supernotes')
    land('twin-b', 'att-twin-b', abs('SUPERNOTES/p.png'), 'b-bytes')
    expect(applyPeerUpdate({ attachmentId: 'att-b2' })).toBe('applied')

    land('twin-b', 'att-b2', abs('SUPERNOTES/p.png'), 'b-new')

    expect(read('Supernotes/p.png')).toBe('b-new')
    expect(conflictCopies('Supernotes')).toEqual([])
  })

  it('a landing whose rename keeps failing keeps one conflict copy', () => {
    twins('Supernotes')
    fs.writeFileSync(abs('Supernotes/p.png'), 'edited offline')
    expect(applyPeerUpdate({ folderPath: 'Other' })).toBe('applied')

    // Each retry asks where to land; the rename fails (the file is open elsewhere).
    for (let i = 0; i < 3; i++) {
      landCaseTwinDownload(abs('Supernotes/p.png'), 'att-twin-a', sha256('a-bytes'))
    }

    expect(conflictCopies('Supernotes')).toEqual(['p (conflict copy).png'])
    expect(read('Supernotes/p (conflict copy).png')).toBe('edited offline')
  })

  // REVIEW-5602 #1: a fresh device has no file and no landing recorded.
  it("on a fresh device the second twin's bytes landing keep no conflict copy of the first's", () => {
    twins('Supernotes')
    fs.rmSync(abs('Supernotes/p.png'))

    land('twin-a', 'att-twin-a', abs('Supernotes/p.png'), 'a-bytes')
    land('twin-b', 'att-twin-b', abs('SUPERNOTES/p.png'), 'b-bytes')

    expect(read('Supernotes/p.png')).toBe('b-bytes')
    expect(conflictCopies('Supernotes')).toEqual([])
  })

  it('on a fresh device a twin downloading its own bytes again keeps no conflict copy', () => {
    twins('Supernotes')
    fs.rmSync(abs('Supernotes/p.png'))

    land('twin-a', 'att-twin-a', abs('Supernotes/p.png'), 'a-bytes')
    land('twin-a', 'att-twin-a', abs('Supernotes/p.png'), 'a-bytes')
    land('twin-b', 'att-twin-b', abs('SUPERNOTES/p.png'), 'b-bytes')

    expect(conflictCopies('Supernotes')).toEqual([])
  })

  // REVIEW-5602 #2: the shared branch's version of the test above.
  it('a landing on a still-shared file whose rename keeps failing keeps one conflict copy', () => {
    twins('Supernotes')
    land('twin-b', 'att-twin-b', abs('SUPERNOTES/p.png'), 'b-bytes')
    fs.writeFileSync(abs('Supernotes/p.png'), 'edited offline')
    expect(applyPeerUpdate({ attachmentId: 'att-b2' })).toBe('applied')

    for (let i = 0; i < 3; i++) {
      landCaseTwinDownload(abs('SUPERNOTES/p.png'), 'att-b2', sha256('b-new'), 'twin-b')
    }
    // A relaunch keeps nothing in memory.
    resetAttachmentDownloadSession()
    land('twin-b', 'att-b2', abs('SUPERNOTES/p.png'), 'b-new')

    expect(read('Supernotes/p.png')).toBe('b-new')
    expect(conflictCopies('Supernotes')).toEqual(['p (conflict copy).png'])
    expect(read('Supernotes/p (conflict copy).png')).toBe('edited offline')

    // Copied back while the copy still holds them, the kept bytes split off later are not kept again.
    fs.copyFileSync(abs('Supernotes/p (conflict copy).png'), abs('Supernotes/p.png'))
    expect(applyPeerDelete('twin-b')).toBe('applied')
    land('twin-a', 'att-twin-a', abs('Supernotes/p.png'), 'a-bytes')
    expect(read('Supernotes/p.png')).toBe('a-bytes')
    expect(conflictCopies('Supernotes')).toEqual(['p (conflict copy).png'])
    expect(read('Supernotes/p (conflict copy).png')).toBe('edited offline')
  })

  const COPY = 'Supernotes/p (conflict copy).png'

  /** A still-shared landing kept an offline edit as a copy. */
  function keepOfflineEdit(): void {
    twins('Supernotes')
    land('twin-b', 'att-twin-b', abs('SUPERNOTES/p.png'), 'b-bytes')
    fs.writeFileSync(abs('Supernotes/p.png'), 'edited offline')
    expect(applyPeerUpdate({ attachmentId: 'att-b2' })).toBe('applied')
    land('twin-b', 'att-b2', abs('SUPERNOTES/p.png'), 'b-new')
  }

  /** ...and the user moved the copy back over the file. */
  function restoreKeptCopy(): void {
    keepOfflineEdit()
    fs.renameSync(abs(COPY), abs('Supernotes/p.png'))
  }

  const keptBytes = () =>
    conflictCopies('Supernotes')
      .map((name) => read(path.join('Supernotes', name)))
      .toSorted()

  // VERIFY-5602 #1 (K1, K2): the copy is gone, so the file is the edit's only copy.
  for (const [how, held] of [
    ['', false],
    [' whose change the watcher held', true]
  ] as const) {
    it(`a restored conflict copy${how} is kept again when a twin's next bytes land on the still-shared file`, () => {
      restoreKeptCopy()
      // The watcher's hold of the restored edit.
      if (held) holdsBinaryChange(vault.path, 'Supernotes/p.png', 'twin-a')
      expect(heldChanges()).toEqual(held ? ['supernotes/p.png'] : [])
      expect(applyPeerUpdate({ attachmentId: 'att-b3' })).toBe('applied')

      land('twin-b', 'att-b3', abs('SUPERNOTES/p.png'), 'b-3')

      expect(read('Supernotes/p.png')).toBe('b-3')
      expect(conflictCopies('Supernotes')).toEqual(['p (conflict copy).png'])
      expect(read('Supernotes/p (conflict copy).png')).toBe('edited offline')
    })
  }

  // VERIFY-5602 #1 (K3).
  it('a restored conflict copy is kept again when the survivor of a split gets its bytes', () => {
    restoreKeptCopy()

    expect(applyPeerDelete('twin-b')).toBe('applied')
    land('twin-a', 'att-twin-a', abs('Supernotes/p.png'), 'a-bytes')

    expect(read('Supernotes/p.png')).toBe('a-bytes')
    expect(conflictCopies('Supernotes')).toEqual(['p (conflict copy).png'])
    expect(read('Supernotes/p (conflict copy).png')).toBe('edited offline')
  })

  // VERIFY-5602R2 #1: the user copied the conflict copy back, so at the split
  // both files hold the edit; the copy goes or changes before the survivor's
  // bytes land, leaving the file the edit's only copy.
  for (const [how, split, landLeaver, changeCopy, kept] of [
    [
      'deleted after a peer delete',
      () => applyPeerDelete('twin-b'),
      () => {},
      () => fs.rmSync(abs(COPY)),
      ['edited offline']
    ],
    [
      'deleted after a peer move',
      () => applyPeerUpdate({ folderPath: 'Other' }),
      () => land('twin-b', 'att-twin-b', abs('Other/p.png'), 'b-bytes'),
      () => fs.rmSync(abs(COPY)),
      ['edited offline']
    ],
    [
      'changed after a peer delete',
      () => applyPeerDelete('twin-b'),
      () => {},
      () => fs.writeFileSync(abs(COPY), 'copy edited'),
      ['copy edited', 'edited offline']
    ]
  ] as const) {
    it(`a restored edit whose conflict copy is ${how} is kept again when the twins' bytes land`, () => {
      keepOfflineEdit()
      fs.copyFileSync(abs(COPY), abs('Supernotes/p.png'))
      expect(split()).toBe('applied')
      changeCopy()

      landLeaver()
      land('twin-a', 'att-twin-a', abs('Supernotes/p.png'), 'a-bytes')

      expect(read('Supernotes/p.png')).toBe('a-bytes')
      expect(keptBytes()).toEqual(kept)
    })
  }

  // VERIFY-5602R2 #6: after a split, the rename fails and the user moves the copy back.
  it('a conflict copy moved back over the file before a failed landing is retried is kept again', () => {
    twins('Supernotes')
    fs.writeFileSync(abs('Supernotes/p.png'), 'edited offline')
    expect(applyPeerDelete('twin-b')).toBe('applied')
    landCaseTwinDownload(abs('Supernotes/p.png'), 'att-twin-a', sha256('a-bytes'), 'twin-a')
    fs.renameSync(abs(COPY), abs('Supernotes/p.png'))

    land('twin-a', 'att-twin-a', abs('Supernotes/p.png'), 'a-bytes')

    expect(read('Supernotes/p.png')).toBe('a-bytes')
    expect(keptBytes()).toEqual(['edited offline'])
  })

  // VERIFY-5602R2 #5: a folder where the kept copy was, and the edit dropped on the file again.
  it("a folder at a kept conflict copy's path does not fail the next landing", () => {
    keepOfflineEdit()
    fs.rmSync(abs(COPY))
    fs.mkdirSync(abs(COPY))
    fs.writeFileSync(abs('Supernotes/p.png'), 'edited offline')
    expect(applyPeerUpdate({ attachmentId: 'att-b3' })).toBe('applied')

    land('twin-b', 'att-b3', abs('SUPERNOTES/p.png'), 'b-3')

    expect(read('Supernotes/p.png')).toBe('b-3')
    expect(read('Supernotes/p (conflict copy) 1.png')).toBe('edited offline')
  })

  // VERIFY-5602 #11: `ılık` and `Ilık` share a fold key but are two files on APFS.
  it('landings on two files that share only a fold key record no case twin state', () => {
    seed('dotless', 'Docs/ılık.png', 'd-bytes')
    seed('capital', 'Docs/Ilık.png', 'c-bytes')
    fs.rmSync(abs('Docs/ılık.png'))
    fs.rmSync(abs('Docs/Ilık.png'))

    land('dotless', 'att-dotless', abs('Docs/ılık.png'), 'd-bytes')
    land('capital', 'att-capital', abs('Docs/Ilık.png'), 'c-bytes')

    expect(read('Docs/ılık.png')).toBe('d-bytes')
    expect(read('Docs/Ilık.png')).toBe('c-bytes')
    expect(landedHashes()).toEqual({})
  })

  // VERIFY-5602R2 #3: `ilik` and `ILIK` share a file, `ılık` only their fold key.
  it("a landing on a file that only shares a fold key with twins' file keeps their landing known", () => {
    seed('lower', 'Docs/ilik.png', 'l-bytes')
    seed('upper', 'Docs/ILIK.png', 'u-bytes')
    seed('dotless', 'Docs/ılık.png', 'd-bytes')
    fs.rmSync(abs('Docs/ılık.png'))
    land('upper', 'att-upper', abs('Docs/ILIK.png'), 'u-bytes')

    land('dotless', 'att-dotless', abs('Docs/ılık.png'), 'd-bytes')
    expect(applyPeerDelete('upper')).toBe('applied')
    land('lower', 'att-lower', abs('Docs/ilik.png'), 'l-bytes')

    expect(read('Docs/ilik.png')).toBe('l-bytes')
    expect(conflictCopies('Docs')).toEqual([])
  })

  // REVIEW-5602 low 6: the landing kept the held change; a later split does not keep it again.
  it('a held change kept by a still-shared landing is not kept again at the split', () => {
    twins('Supernotes')
    land('twin-b', 'att-twin-b', abs('SUPERNOTES/p.png'), 'b-bytes')
    fs.writeFileSync(abs('Supernotes/p.png'), 'edited offline')
    // The watcher's hold of the edit.
    expect(holdsBinaryChange(vault.path, 'Supernotes/p.png', 'twin-a')).toBe(true)
    expect(heldChanges()).toEqual(['supernotes/p.png'])
    expect(applyPeerUpdate({ attachmentId: 'att-b2' })).toBe('applied')

    land('twin-b', 'att-b2', abs('SUPERNOTES/p.png'), 'b-new')
    expect(applyPeerDelete('twin-b')).toBe('applied')
    land('twin-a', 'att-twin-a', abs('Supernotes/p.png'), 'a-bytes')

    expect(conflictCopies('Supernotes')).toEqual(['p (conflict copy).png'])
  })

  // VERIFY-5602R3 #7: the moved twin's copy holds the offline edit too, and is
  // its only file once the user changes the shared file again.
  for (const [how, threeTwins] of [
    ['the last twin', false],
    ['one of three twins', true]
  ] as const) {
    it(`an offline edit copied to a twin moved off ${how} is kept when the moved twin's bytes land`, () => {
      twins('Supernotes')
      if (threeTwins) seed('twin-c', 'SuperNotes/p.png', 'b-bytes')
      land('twin-b', 'att-twin-b', abs('SUPERNOTES/p.png'), 'b-bytes')
      fs.writeFileSync(abs('Supernotes/p.png'), 'edited offline')
      expect(applyPeerUpdate({ folderPath: 'Other' })).toBe('applied')
      fs.writeFileSync(abs('Supernotes/p.png'), 'edited again')

      land('twin-b', 'att-twin-b', abs('Other/p.png'), 'b-bytes')

      expect(read('Other/p.png')).toBe('b-bytes')
      expect(read('Other/p (conflict copy).png')).toBe('edited offline')
      expect(read('Supernotes/p.png')).toBe('edited again')
    })
  }

  // VERIFY-5602R3 #3: `existsSync` follows the link and reads the path as free.
  it("a dangling symlink at the conflict copy's path does not fail the landing", () => {
    twins('Supernotes')
    fs.writeFileSync(abs('Supernotes/p.png'), 'edited offline')
    expect(applyPeerDelete('twin-b')).toBe('applied')
    fs.symlinkSync(abs('gone.png'), abs(COPY))

    land('twin-a', 'att-twin-a', abs('Supernotes/p.png'), 'a-bytes')

    expect(read('Supernotes/p.png')).toBe('a-bytes')
    expect(read('Supernotes/p (conflict copy) 1.png')).toBe('edited offline')
    expect(fs.readlinkSync(abs(COPY))).toBe(abs('gone.png'))
  })

  // REVIEW-5680 #1: the moving twin's copy followed a dangling link out of the vault.
  it("a peer's move of a binary twin onto a dangling link writes nothing outside the vault", () => {
    twins('Supernotes')
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'memry-outside-')), 'p.png')
    try {
      fs.mkdirSync(abs('Other'))
      fs.symlinkSync(outside, abs('Other/p.png'))

      expect(applyPeerUpdate({ folderPath: 'Other' })).toBe('applied')

      expect(rows()).toEqual([
        { id: 'twin-a', path: 'Supernotes/p.png' },
        { id: 'twin-b', path: 'Other/p 1.png' }
      ])
      expect(read('Other/p 1.png')).toBe('b-bytes')
      expect(fs.existsSync(outside)).toBe(false)
    } finally {
      fs.rmSync(path.dirname(outside), { recursive: true, force: true })
    }
  })

  // REVIEW-5662 #3: a twin's own download is in flight when a peer deletes it.
  it("a deleted twin's download lands nothing and records no hash", () => {
    twins('Supernotes')
    expect(applyPeerDelete('twin-b')).toBe('applied')

    expect(() => land('twin-b', 'att-twin-b', abs('SUPERNOTES/p.png'), 'b-new')).toThrow(
      SupersededDownloadError
    )

    expect(read('Supernotes/p.png')).toBe('b-bytes')
    expect(conflictCopies('Supernotes')).toEqual([])
    expect(readSyncedBinaryHash(asClientDb(data.db), 'twin-b')).toBeUndefined()
  })

  it('a download whose note is deleted while its bytes land records no hash', () => {
    seed('solo', 'Other/s.png', 's-bytes')
    const at = landCaseTwinDownload(abs('Other/s.png'), 'att-solo', sha256('s-new'), 'solo')
    expect(applyPeerDelete('solo')).toBe('applied')

    fs.writeFileSync(at, 's-new')
    recordDownloadedFileSize('solo', 'att-solo', 's-new'.length, sha256('s-new'))

    expect(readSyncedBinaryHash(asClientDb(data.db), 'solo')).toBeUndefined()
  })

  // REVIEW-5662 #4: A is marked as the survivor of B's move, and a pull since
  // named its file for twin A2. A's delete marks A2 and clears A's mark alone.
  it("a marked twin's delete clears its own mark and keeps every other", () => {
    twins('Supernotes')
    expect(applyPeerUpdate({ folderPath: 'Other' })).toBe('applied')
    seed('twin-a2', 'SUPERNOTES/p.png', 'b-bytes')
    const marked = () => listCaseTwinForeignBytes(asClientDb(data.db)).toSorted()
    expect(marked()).toEqual(['twin-a', 'twin-b'])

    expect(applyPeerDelete('twin-a')).toBe('applied')

    expect(rows().map((row) => row.id)).toEqual(['twin-a2', 'twin-b'])
    expect(marked()).toEqual(['twin-a2', 'twin-b'])
  })

  it('the attachment backfill uploads no twin while its file is shared', async () => {
    twins('Supernotes', { attachmentId: null })
    seed('solo', 'Other/s.png', 's-bytes', { attachmentId: null })
    const { backfillUnsyncedAttachmentsWith } = await vi.importActual<typeof AttachmentBackfill>(
      '../sync/attachment-backfill'
    )

    backfillUnsyncedAttachmentsWith({ db: asClientDb(data.db), vaultPath: vault.path })

    expect(listPendingUploads(asClientDb(data.db)).map((row) => row.noteId)).toEqual(['solo'])
  })

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

// VERIFY-5602 #11: a volume that keeps case (Linux) keeps each spelling as its own file.
describe.runIf(!fileSystemIgnoresCase())(
  'binary notes whose paths differ in case on a case-sensitive volume',
  () => {
    let vault: ReturnType<typeof createTestVault>
    let data: TestDatabaseResult
    let index: TestDatabaseResult

    beforeEach(() => {
      vault = createTestVault('case-sensitive-binary')
      data = createTestDataDb()
      index = createTestIndexDb()
      vi.mocked(getDatabase).mockReturnValue(asClientDb(data.db))
      vi.mocked(getIndexDatabase).mockReturnValue(index.db)
      vi.mocked(getStatus).mockReturnValue({
        isOpen: true,
        path: vault.path,
        isIndexing: false,
        indexProgress: 100,
        error: null
      })
    })

    afterEach(() => {
      index.close()
      data.close()
      vault.cleanup()
      vi.clearAllMocks()
    })

    it('their landings record no case twin state', () => {
      const notes = [
        ['lower', 'Supernotes/p.png'],
        ['upper', 'SUPERNOTES/p.png']
      ] as const
      for (const [id, relativePath] of notes) {
        upsertNoteMetadata(asClientDb(data.db), {
          id,
          path: relativePath,
          title: 'p',
          fileType: 'image',
          mimeType: 'image/png',
          attachmentId: `att-${id}`,
          localOnly: false,
          clock: { dev1: 1 },
          createdAt: '2026-01-10T00:00:00.000Z',
          modifiedAt: '2026-01-12T00:00:00.000Z',
          syncedAt: '2026-01-12T00:00:00.000Z',
          fileSize: 7
        })
      }

      for (const [id, relativePath] of notes) {
        const bytes = `${id}-bytes`
        const at = landCaseTwinDownload(
          path.join(vault.path, relativePath),
          `att-${id}`,
          createHash('sha256').update(bytes).digest('hex'),
          id
        )
        fs.mkdirSync(path.dirname(at), { recursive: true })
        fs.writeFileSync(at, bytes)
        expect(
          data.db
            .select()
            .from(syncState)
            .all()
            .map((row) => row.key)
        ).toEqual([])
      }

      expect(fs.readFileSync(path.join(vault.path, 'Supernotes/p.png'), 'utf8')).toBe('lower-bytes')
      expect(fs.readFileSync(path.join(vault.path, 'SUPERNOTES/p.png'), 'utf8')).toBe('upper-bytes')
    })
  }
)
