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
import { clearIngestBackfill } from './ingest-backfill'
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
    file: { fileType?: 'markdown' | 'pdf'; fileSize?: number | null } = {}
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
      contentHash: `hash-${id}`
    })
    data.db.insert(noteMetadata).values(fields).run()
  }

  function seedCanvas(id: string, relativePath: string): void {
    fs.mkdirSync(path.dirname(abs(relativePath)), { recursive: true })
    fs.writeFileSync(abs(relativePath), JSON.stringify({ type: 'excalidraw', elements: [] }))
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

  async function openVault(): Promise<void> {
    await watcher.replayMissedRemovals()
    // The rename window a live unlink gets, then the projection of the delete.
    await vi.advanceTimersByTimeAsync(600)
    // The window's decision stats the disk off the timer turn.
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve))
    await flushProjectionEvents()
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

    await openVault()

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
})
