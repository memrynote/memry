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
import { attachmentEvents } from '@memry/sync-client/attachment-events'
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
import { landCaseTwinDownload, releaseAbandonedCaseTwinBytes } from './case-twin-file'
import { noteHandler } from '../sync/item-handlers/note-handler'
import { redriveAttachmentDownloads } from '../sync/attachment-download-redriver'
import { recordDownloadedFileSize } from '../sync/note-attachment-metadata'
import { listPendingUploads } from '../sync/attachment-outbox'
import {
  MISSING_PROBE_LIMIT,
  markDownloadFailed,
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
    const at = landCaseTwinDownload(requestedPath, attachmentId, sha256(bytes))
    markWritebackIgnored(at)
    fs.writeFileSync(at, bytes)
    recordDownloadedFileSize(id, bytes.length)
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

  const foreignMarks = (): unknown =>
    JSON.parse(
      data.db
        .select({ value: syncState.value })
        .from(syncState)
        .where(eq(syncState.key, 'caseTwinForeignBytes'))
        .get()?.value ?? '{}'
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
      expect(foreignMarks()).toMatchObject({ 'twin-a': null })
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
