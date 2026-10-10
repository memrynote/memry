/**
 * A note or canvas removed while the app was closed syncs its delete when the
 * vault opens, the way a live unlink does (#3013). Every doubt keeps the item:
 * an iCloud placeholder (#3004, until it is gone too: #3010), an unreadable
 * file, an attachment never downloaded, unflushed sync writes, an unmounted
 * vault.
 *
 * @module vault/watcher-missed-removals.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { eq } from 'drizzle-orm'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { canvasAssets, canvases } from '@memry/db-schema/data-schema'
import { createTestVault } from '@tests/utils/test-vault'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { insertNoteCache } from '@main/database/queries/notes'

const mocks = vi.hoisted(() => ({
  watch: vi.fn(),
  hasBulkApplyJournal: vi.fn(() => false),
  canvasContext: null as null | { db: unknown; vaultId: string; vaultPath: string }
}))

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: vi.fn(() => []) } }))
vi.mock('chokidar', () => ({ default: { watch: mocks.watch }, watch: mocks.watch }))
vi.mock('../database', () => ({
  getIndexDatabase: vi.fn(),
  getDatabase: vi.fn(),
  isDatabaseInitialized: () => true,
  updateFtsContent: vi.fn()
}))
vi.mock('../sync/bulk-apply', () => ({ hasBulkApplyJournal: mocks.hasBulkApplyJournal }))
vi.mock('../inbox/suggestions', () => ({ updateNoteEmbedding: vi.fn() }))
vi.mock('../journal/runtime-effects', () => ({
  enqueueJournalCreate: vi.fn(),
  enqueueJournalDelete: vi.fn(),
  initializeJournalCrdt: vi.fn()
}))
vi.mock('../notes/runtime-effects', () => ({
  syncNoteCreate: vi.fn(),
  syncNoteDelete: vi.fn(),
  syncNoteUpdate: vi.fn(),
  unlinkTasksFromDeletedNote: vi.fn(),
  queueEmbeddedVaultFiles: vi.fn()
}))
vi.mock('../canvas/sync-bridge', () => ({ syncCanvasDelete: vi.fn() }))
vi.mock('../canvas/vault-key', () => ({ getCanvasContext: () => mocks.canvasContext }))
vi.mock('../sync/crdt-external-feed', () => ({ feedExternalEditToCrdt: vi.fn(async () => {}) }))
vi.mock('../tasks/reconcile-markdown-tasks', () => ({
  reconcileTaskCheckboxesFromMarkdown: vi.fn(async () => {})
}))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))
vi.mock('./index', () => ({
  emitIndexProgress: vi.fn(),
  getConfig: () => ({
    excludePatterns: [],
    defaultNoteFolder: 'notes',
    journalFolder: 'journal',
    journalDateFormat: 'YYYY-MM-DD',
    attachmentsFolder: 'attachments'
  })
}))

import { getDatabase, getIndexDatabase } from '../database'
import { syncNoteDelete } from '../notes/runtime-effects'
import { syncCanvasDelete } from '../canvas/sync-bridge'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import {
  flushProjectionEvents,
  startProjectionRuntime,
  stopProjectionRuntime
} from '../projections'
import { reconcileCanvasFiles } from '../canvas/reconcile'
import { withCanvasMeta } from '../canvas/scene-file'
import { scanMarkdownFile } from './file-scan'
import { clearIngestBackfill, drainIngestBackfill } from './ingest-backfill'
import { indexVault } from './indexer'
import { clearAllPendingDeletes } from './rename-tracker'
import { VaultWatcher } from './watcher'

const VAULT_ID = 'vault-1'

function fakeChokidar(): { close: ReturnType<typeof vi.fn> } {
  const fake = {
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'ready') handler()
      return fake
    }),
    once: vi.fn(() => fake),
    close: vi.fn(async () => {})
  }
  return fake
}

describe('vault open replays removals made while the app was closed (#3013)', () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  let watcher: VaultWatcher

  const abs = (relativePath: string): string => path.join(vault.path, relativePath)
  const placeholderOf = (relativePath: string): string =>
    path.join(path.dirname(abs(relativePath)), `.${path.basename(relativePath)}.icloud`)
  const noteRow = (id: string) =>
    index.db.select().from(noteCache).where(eq(noteCache.id, id)).get() ?? null
  const canvasRow = (id: string) =>
    data.db.select().from(canvases).where(eq(canvases.id, id)).get() ?? null

  function seedNote(
    id: string,
    relativePath: string,
    file: { fileType?: 'markdown' | 'pdf'; fileSize?: number | null; contentHash?: string } = {}
  ): void {
    fs.mkdirSync(path.dirname(abs(relativePath)), { recursive: true })
    fs.writeFileSync(abs(relativePath), `${id} text\n`)
    const fields = {
      id,
      path: relativePath,
      title: id,
      fileType: file.fileType ?? ('markdown' as const),
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z'
    }
    insertNoteCache(index.db, {
      ...fields,
      fileSize: file.fileSize === undefined ? 10 : file.fileSize,
      contentHash: file.contentHash ?? `hash-${id}`
    })
    data.db.insert(noteMetadata).values(fields).run()
  }

  /** A note whose cached hash is the one its file really has, so a move can pair. */
  async function seedHashedNote(id: string, relativePath: string): Promise<void> {
    seedNote(id, relativePath)
    const scan = await scanMarkdownFile(abs(relativePath), 0)
    index.db
      .update(noteCache)
      .set({ contentHash: scan!.contentHash })
      .where(eq(noteCache.id, id))
      .run()
  }

  const idAt = (relativePath: string): string | null =>
    index.db.select().from(noteCache).where(eq(noteCache.path, relativePath)).get()?.id ?? null

  function seedCanvas(id: string, relativePath: string): void {
    fs.mkdirSync(path.dirname(abs(relativePath)), { recursive: true })
    fs.writeFileSync(
      abs(relativePath),
      withCanvasMeta(JSON.stringify({ type: 'excalidraw', elements: [] }), {
        id,
        createdAt: 1,
        updatedAt: 1
      })
    )
    data.db
      .insert(canvases)
      .values({
        id,
        vaultId: VAULT_ID,
        title: id,
        filePath: relativePath,
        folder: '',
        snapshotCiphertext: '',
        vectorClock: {},
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
        lastSyncedAt: null,
        clock: null
      })
      .run()
  }

  /** The open order of `runBackgroundIndexBuild`: canvas reconcile, replay, walk. */
  async function openVault(): Promise<void> {
    await reconcileCanvasFiles(data.db as never, vault.path, VAULT_ID)
    await watcher.replayMissedRemovals()
    await indexVault(vault.path)
    // The rename window a live unlink gets, then the projection of the delete.
    await vi.advanceTimersByTimeAsync(600)
    // The window's decision stats the disk off the timer turn.
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve))
    await flushProjectionEvents()
    // A moved file's body is read in the background; finish it inside the test.
    await drainIngestBackfill()
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    mocks.watch.mockImplementation(fakeChokidar)
    mocks.hasBulkApplyJournal.mockReturnValue(false)
    vault = createTestVault('watcher-missed-removals')
    fs.writeFileSync(path.join(vault.path, '.memry', 'data.db'), '')
    data = createTestDataDb()
    index = createTestIndexDb()
    mocks.canvasContext = { db: data.db, vaultId: VAULT_ID, vaultPath: vault.path }
    vi.mocked(getDatabase).mockReturnValue(data.db as never)
    vi.mocked(getIndexDatabase).mockReturnValue(index.db)
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])
    seedNote('note-kept', 'notes/kept.md')
    watcher = new VaultWatcher()
    await watcher.start({ vaultPath: vault.path })
  })

  afterEach(async () => {
    await watcher.stop()
    await stopProjectionRuntime({ drain: true })
    clearAllPendingDeletes()
    clearIngestBackfill()
    data.close()
    index.close()
    vault.cleanup()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('syncs the delete of a note removed while closed, and a restored file gets a new id', async () => {
    seedNote('note-gone', 'notes/gone.md')
    fs.rmSync(abs('notes/gone.md'))

    await openVault()

    expect(syncNoteDelete).toHaveBeenCalledWith('note-gone')
    expect(syncNoteDelete).toHaveBeenCalledTimes(1)
    expect(noteRow('note-gone')).toBeNull()
    expect(
      data.db.select().from(noteMetadata).where(eq(noteMetadata.id, 'note-gone')).get()
    ).toBeUndefined()
    expect(noteRow('note-kept')?.path).toBe('notes/kept.md')

    // Put back from the Trash: a create under a fresh id, never the old one (#3012).
    fs.writeFileSync(abs('notes/gone.md'), 'note-gone text\n')
    await (watcher as unknown as { handleFileAdd(p: string): Promise<void> }).handleFileAdd(
      abs('notes/gone.md')
    )
    await flushProjectionEvents()
    const restored = index.db
      .select()
      .from(noteCache)
      .where(eq(noteCache.path, 'notes/gone.md'))
      .get()
    expect(restored?.id).toBeDefined()
    expect(restored?.id).not.toBe('note-gone')
  })

  it('keeps an evicted note until its iCloud placeholder is gone too (#3004, #3010)', async () => {
    seedNote('note-evicted', 'notes/evicted.md')
    fs.renameSync(abs('notes/evicted.md'), placeholderOf('notes/evicted.md'))

    await openVault()
    expect(syncNoteDelete).not.toHaveBeenCalled()
    expect(noteRow('note-evicted')?.path).toBe('notes/evicted.md')

    // Deleted later: the watcher never sees a dotfile go, so the next open does.
    fs.rmSync(placeholderOf('notes/evicted.md'))
    await openVault()
    expect(syncNoteDelete).toHaveBeenCalledWith('note-evicted')
    expect(noteRow('note-evicted')).toBeNull()
  })

  it('keeps a note whose file cannot be checked', async () => {
    seedNote('note-locked', 'locked/locked.md')
    fs.chmodSync(abs('locked'), 0o000)
    try {
      await openVault()
    } finally {
      fs.chmodSync(abs('locked'), 0o755)
    }

    expect(syncNoteDelete).not.toHaveBeenCalled()
    expect(noteRow('note-locked')?.path).toBe('locked/locked.md')
  })

  it('keeps a synced attachment this device never downloaded', async () => {
    seedNote('pdf-pending', 'notes/report.pdf', { fileType: 'pdf', fileSize: 0 })
    fs.rmSync(abs('notes/report.pdf'))

    await openVault()

    expect(syncNoteDelete).not.toHaveBeenCalled()
    expect(noteRow('pdf-pending')?.path).toBe('notes/report.pdf')
  })

  it('waits while a crashed sync apply still owes note files', async () => {
    seedNote('note-unflushed', 'notes/unflushed.md')
    fs.rmSync(abs('notes/unflushed.md'))
    mocks.hasBulkApplyJournal.mockReturnValue(true)

    await openVault()

    expect(syncNoteDelete).not.toHaveBeenCalled()
    expect(noteRow('note-unflushed')?.path).toBe('notes/unflushed.md')
  })

  it('deletes nothing when the vault is not mounted', async () => {
    seedNote('note-gone', 'notes/gone.md')
    fs.rmSync(abs('notes/gone.md'))
    fs.rmSync(path.join(vault.path, '.memry', 'data.db'))

    await openVault()

    expect(syncNoteDelete).not.toHaveBeenCalled()
    expect(noteRow('note-gone')?.path).toBe('notes/gone.md')
  })

  it('syncs the delete of a canvas removed while closed, keeping its assets and an evicted one', async () => {
    seedCanvas('canvas-gone', 'canvases/Gone.excalidraw')
    seedCanvas('canvas-evicted', 'canvases/Evicted.excalidraw')
    data.db
      .insert(canvasAssets)
      .values({
        vaultId: VAULT_ID,
        canvasId: 'canvas-gone',
        contentHash: 'h1',
        attachmentId: 'a1',
        fileId: 'f1',
        filename: 'h1.png',
        mimeType: 'image/png',
        sizeBytes: 1,
        chunkHashes: [],
        createdAt: 1
      })
      .run()
    fs.rmSync(abs('canvases/Gone.excalidraw'))
    fs.renameSync(abs('canvases/Evicted.excalidraw'), placeholderOf('canvases/Evicted.excalidraw'))

    // Settled by the replay itself, not by a window on the clock.
    await reconcileCanvasFiles(data.db as never, vault.path, VAULT_ID)
    await watcher.replayMissedRemovals()

    expect(syncCanvasDelete).toHaveBeenCalledWith('canvas-gone')
    expect(syncCanvasDelete).toHaveBeenCalledTimes(1)
    expect(canvasRow('canvas-gone')?.deletedAt).not.toBeNull()
    // Its path is released, so a document put back there is a new canvas (#3012).
    expect(canvasRow('canvas-gone')?.filePath).toBeNull()
    expect(canvasRow('canvas-evicted')?.deletedAt).toBeNull()
    expect(
      data.db.select().from(canvasAssets).where(eq(canvasAssets.canvasId, 'canvas-gone')).all()
    ).toHaveLength(1)

    fs.rmSync(placeholderOf('canvases/Evicted.excalidraw'))
    await openVault()
    expect(syncCanvasDelete).toHaveBeenCalledWith('canvas-evicted')
  })

  it('keeps the ids of notes, a folder of notes and a canvas moved while closed', async () => {
    await seedHashedNote('note-renamed', 'notes/old-name.md')
    await seedHashedNote('note-in-a', 'projects/a/one.md')
    await seedHashedNote('note-in-b', 'projects/a/two.md')
    seedCanvas('canvas-moved', 'canvases/Board.excalidraw')
    fs.renameSync(abs('notes/old-name.md'), abs('notes/new-name.md'))
    fs.renameSync(abs('projects/a'), abs('projects/b'))
    fs.mkdirSync(abs('canvases/sub'))
    fs.renameSync(abs('canvases/Board.excalidraw'), abs('canvases/sub/Board.excalidraw'))

    await openVault()
    await vi.advanceTimersByTimeAsync(2000)
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve))

    expect(syncNoteDelete).not.toHaveBeenCalled()
    expect(syncCanvasDelete).not.toHaveBeenCalled()
    expect(idAt('notes/new-name.md')).toBe('note-renamed')
    expect(idAt('projects/b/one.md')).toBe('note-in-a')
    expect(idAt('projects/b/two.md')).toBe('note-in-b')
    expect(canvasRow('canvas-moved')).toMatchObject({
      deletedAt: null,
      filePath: 'canvases/sub/Board.excalidraw'
    })
  })

  /**
   * A folder moved while closed, opened on real timers with every add made slow
   * through the replay's own add path, so the adds run well past the 500 ms a
   * live unlink waits for its rename. Returns how long the replay took.
   */
  async function openVaultWithSlowAdds(moved: number): Promise<number> {
    vi.useRealTimers()
    const internals = watcher as unknown as { handleFileAdd(p: string): Promise<void> }
    const handleFileAdd = internals.handleFileAdd.bind(watcher)
    internals.handleFileAdd = async (p: string) => {
      await new Promise((resolve) => setTimeout(resolve, 1000 / moved))
      await handleFileAdd(p)
    }
    try {
      await reconcileCanvasFiles(data.db as never, vault.path, VAULT_ID)
      const started = Date.now()
      await watcher.replayMissedRemovals()
      const replayMs = Date.now() - started
      await indexVault(vault.path)
      await new Promise((resolve) => setTimeout(resolve, 700))
      await flushProjectionEvents()
      await drainIngestBackfill()
      return replayMs
    } finally {
      internals.handleFileAdd = handleFileAdd
    }
  }

  it('keeps the ids of a large folder moved while closed, however long the adds take', async () => {
    for (let i = 0; i < 12; i++) await seedHashedNote(`note-${i}`, `projects/a/n${i}.md`)
    fs.renameSync(abs('projects/a'), abs('projects/b'))

    expect(await openVaultWithSlowAdds(12)).toBeGreaterThan(900)

    expect(syncNoteDelete).not.toHaveBeenCalled()
    for (let i = 0; i < 12; i++) expect(idAt(`projects/b/n${i}.md`)).toBe(`note-${i}`)
  })

  it('keeps the ids of a folder moved while closed past the mass-removal guard, on every open', async () => {
    for (let i = 0; i < 25; i++) await seedHashedNote(`note-${i}`, `projects/a/n${i}.md`)
    fs.renameSync(abs('projects/a'), abs('projects/b'))

    expect(await openVaultWithSlowAdds(25)).toBeGreaterThan(900)
    for (let i = 0; i < 25; i++) expect(idAt(`projects/b/n${i}.md`)).toBe(`note-${i}`)
    expect(index.db.select().from(noteCache).all()).toHaveLength(26)

    // The next open finds nothing missing, so no old id is left to delete.
    await openVaultWithSlowAdds(25)
    expect(syncNoteDelete).not.toHaveBeenCalled()
  })

  it('syncs no deletes when too many files are missing at once, and checks again next open', async () => {
    for (let i = 0; i < 30; i++) seedNote(`note-${i}`, `notes/n${i}.md`)
    for (let i = 0; i < 21; i++) fs.rmSync(abs(`notes/n${i}.md`))

    await openVault()

    expect(syncNoteDelete).not.toHaveBeenCalled()
    expect(noteRow('note-0')?.path).toBe('notes/n0.md')

    // The rest of the copy landed: one file really was deleted.
    for (let i = 1; i < 21; i++) fs.writeFileSync(abs(`notes/n${i}.md`), `note-${i} text\n`)
    await openVault()
    expect(vi.mocked(syncNoteDelete).mock.calls).toEqual([['note-0']])
  })
})
