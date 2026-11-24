/**
 * A binary note (image, PDF, audio, video) has no CRDT body: its file is the
 * blob (#5412). Created through the watcher's add path, it got a doc whose
 * title write went to the server as a body update, and again as a snapshot at
 * quit (#5607). The watcher, `syncNoteCreate`, the provider and the note-body
 * outbox are real here; the provider runs without a store.
 *
 * @module sync/binary-note-crdt-body.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { eq } from 'drizzle-orm'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { SyncQueueManager } from '@memry/sync-client/queue'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { createTestVault } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false, getVersion: () => '0.0.0' },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  shell: { trashItem: vi.fn() }
}))
vi.mock('../database/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDatabase: vi.fn(),
  getIndexDatabase: vi.fn(),
  isDatabaseInitialized: () => true,
  isIndexDatabaseInitialized: () => true
}))
// No store: the provider runs in memory, as with a store that failed to open.
vi.mock('./crdt-store-path', () => ({ prepareVaultCrdtStore: async () => null }))
vi.mock('./local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  removePendingNoteSyncItems: vi.fn()
}))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))

import { getDatabase, getIndexDatabase } from '../database/client'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import { startProjectionRuntime, stopProjectionRuntime } from '../projections'
import { VaultWatcher } from '../vault/watcher'
import { getCrdtProvider, resetCrdtProvider, type SnapshotPushFn } from './crdt-provider'
import { NoteBodyOutbox } from './note-body-outbox'

describe('a binary note added to the vault', () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  const pushSnapshot = vi.fn<SnapshotPushFn>(async () => {})

  beforeEach(async () => {
    vault = createTestVault('binary-note-crdt-body')
    data = createTestDataDb()
    index = createTestIndexDb()
    vi.mocked(getDatabase).mockReturnValue(asClientDb(data.db))
    vi.mocked(getIndexDatabase).mockReturnValue(index.db)
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])
    const outbox = new NoteBodyOutbox({ queue: queue(), push: vi.fn() })
    await getCrdtProvider().init(outbox, pushSnapshot)
  })

  afterEach(async () => {
    resetCrdtProvider()
    await stopProjectionRuntime({ drain: true })
    index.close()
    data.close()
    vault.cleanup()
    vi.clearAllMocks()
  })

  const queue = (): SyncQueueManager => new SyncQueueManager(data.db as unknown as DrizzleDb)

  /** The watcher's add path for a PNG dropped into the vault, as a paste outside the app is. */
  async function addPng(relativePath: string): Promise<string> {
    const absolutePath = path.join(vault.path, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, Buffer.from('png bytes'))
    const watcher = new VaultWatcher() as unknown as {
      vaultPath: string
      handleFileAdd: (filePath: string) => Promise<void>
    }
    watcher.vaultPath = vault.path
    await watcher.handleFileAdd(absolutePath)
    // `syncNoteCreate` floats the doc's init.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const row = data.db
      .select({ id: noteMetadata.id })
      .from(noteMetadata)
      .where(eq(noteMetadata.path, relativePath))
      .get()
    if (!row) throw new Error(`no row for ${relativePath}`)
    return row.id
  }

  it('gets no CRDT doc, so no body update is queued and nothing is pushed at quit', async () => {
    const id = await addPng('notes/photo.png')

    expect({
      doc: getCrdtProvider().getDoc(id),
      queuedBodies: queue().listNoteBodyNoteIds(),
      pushedAtQuit: await getCrdtProvider().pushAllSnapshots()
    }).toEqual({ doc: undefined, queuedBodies: [], pushedAtQuit: 0 })
    expect(pushSnapshot).not.toHaveBeenCalled()
  })

  // A doc opened for one anyway, as an older build left them: a rename
  // writes the doc's title through `updateMeta`.
  it('sends nothing from a doc opened for it, at an edit, at quit or at close', async () => {
    const id = await addPng('notes/photo.png')
    await getCrdtProvider().open(id)

    getCrdtProvider().updateMeta(id, { title: 'renamed' })
    const pushedAtQuit = await getCrdtProvider().pushAllSnapshots()
    await getCrdtProvider().close(id)

    expect({ queuedBodies: queue().listNoteBodyNoteIds(), pushedAtQuit }).toEqual({
      queuedBodies: [],
      pushedAtQuit: 0
    })
    expect(pushSnapshot).not.toHaveBeenCalled()
  })
})
