/**
 * The vault-open pass that drops the note rows an older Windows build made of
 * attachment files (#5607), and the pull that must not bring them back. The
 * data and index DBs, the projections, the CRDT provider, the sync queue and
 * the record applier are real; the doc store is a map behind the provider.
 *
 * @module vault/stray-attachment-rows.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as Y from 'yjs'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import { attachmentUploadQueue } from '@memry/db-schema/schema/attachment-upload-queue'
import { crdtBodyDebts } from '@memry/db-schema/schema/crdt-body-debts'
import { listDeclinedRefs } from '@memry/sync-client/declined-refs'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { upsertNoteMetadata } from '@memry/storage-data'
import { createTestVault } from '@tests/utils/test-vault'
import {
  asClientDb,
  asSyncDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { insertNoteCache } from '@main/database/queries/notes'

const store = vi.hoisted(() => new Map<string, Uint8Array[]>())

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false, getVersion: () => '0.0.0' },
  BrowserWindow: { fromId: () => null, getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  shell: { trashItem: vi.fn() }
}))
vi.mock('../sync/crdt-persistence', async () => {
  const Yjs = await import('yjs')
  return {
    openCrdtPersistence: async () => ({
      getYDoc: async (noteId: string) => {
        const doc = new Yjs.Doc()
        for (const update of store.get(noteId) ?? []) Yjs.applyUpdate(doc, update)
        return doc
      },
      storeUpdate: async (noteId: string, update: Uint8Array) => {
        store.set(noteId, [...(store.get(noteId) ?? []), update])
      },
      flushDocument: async () => {},
      clearDocument: async (noteId: string) => {
        store.delete(noteId)
      },
      destroy: () => {},
      getMeta: async () => undefined,
      setMeta: async () => {}
    })
  }
})
vi.mock('../sync/crdt-store-epoch', () => ({ reconcileCrdtStoreEpoch: async () => {} }))
vi.mock('../sync/crdt-store-path', () => ({
  prepareVaultCrdtStore: async () => ({ storagePath: '/tmp/crdt', vaultUuid: 'vault-1' })
}))
vi.mock('../store', () => ({ recordCrdtPersistenceOutcome: () => 0 }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))
vi.mock('../database', () => ({
  getIndexDatabase: vi.fn(),
  getDatabase: vi.fn(),
  requireDatabase: vi.fn(),
  isDatabaseInitialized: () => true,
  updateFtsContent: vi.fn()
}))
vi.mock('../database/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDatabase: vi.fn(),
  getIndexDatabase: vi.fn(),
  isDatabaseInitialized: () => true,
  isIndexDatabaseInitialized: () => true
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

import { getDatabase, getIndexDatabase } from '../database'
import {
  getDatabase as getClientDatabase,
  getIndexDatabase as getClientIndexDatabase
} from '../database/client'
import { getStatus } from './index'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import { startProjectionRuntime, stopProjectionRuntime } from '../projections'
import { getCrdtProvider, resetCrdtProvider } from '../sync/crdt-provider'
import { queueUploadIfAbsent } from '../sync/attachment-outbox'
import { oweCrdtBodyDebts } from '../sync/engine/crdt-body-debts'
import { ItemApplier } from '../sync/apply-item'
import { forgetStrayAttachmentRows } from './stray-attachment-rows'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const HOST_MD = '# host\n\n![](../attachments/host/abc-pasted.png)\n'
const STRAY_FILE = 'attachments/host/abc-pasted.png'

describe('note rows an older Windows build made of attachment files', () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult

  beforeEach(async () => {
    vault = createTestVault('stray-attachment-rows')
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
    await getCrdtProvider().initPersistence(vault.path)
  })

  afterEach(async () => {
    resetCrdtProvider()
    store.clear()
    await stopProjectionRuntime({ drain: true })
    index.close()
    data.close()
    vault.cleanup()
    vi.clearAllMocks()
  })

  /** A synced row, its index row and its file. */
  function note(id: string, relativePath: string, bytes: Buffer | string): void {
    const fields = {
      id,
      path: relativePath,
      title: path.basename(relativePath, path.extname(relativePath)),
      fileType: typeof bytes === 'string' ? ('markdown' as const) : ('image' as const),
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z',
      syncedAt: '2026-01-12T00:00:00.000Z',
      fileSize: bytes.length
    }
    upsertNoteMetadata(asClientDb(data.db), fields)
    insertNoteCache(index.db, { ...fields, contentHash: null })
    const absolutePath = path.join(vault.path, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, bytes)
  }

  /** The issue's vault: a note embeds a pasted image, and the image is a note too. */
  function strayVault(): void {
    note('host', 'notes/host.md', HOST_MD)
    note('stray', STRAY_FILE, PNG)
    note('photo', 'notes/photo.png', PNG)
    // What an older build left for the stray: a doc, queued items, an upload, a debt.
    const doc = new Y.Doc()
    doc.getMap('meta').set('title', 'abc-pasted')
    store.set('stray', [Y.encodeStateAsUpdate(doc)])
    const queue = new SyncQueueManager(asSyncDb(data.db))
    queue.enqueueNoteBody('stray', 'body')
    queue.enqueue({ type: 'note', itemId: 'stray', operation: 'update', payload: '{}' })
    queueUploadIfAbsent(asSyncDb(data.db), 'stray', path.join(vault.path, STRAY_FILE))
    oweCrdtBodyDebts(asSyncDb(data.db), ['stray'], 'broadcast')
  }

  const state = () => ({
    rows: data.db
      .select({ id: noteMetadata.id })
      .from(noteMetadata)
      .all()
      .map((r) => r.id)
      .toSorted(),
    indexRows: index.db
      .select({ id: noteCache.id })
      .from(noteCache)
      .all()
      .map((r) => r.id)
      .toSorted(),
    strayFile: fs.readFileSync(path.join(vault.path, STRAY_FILE)),
    hostFile: fs.readFileSync(path.join(vault.path, 'notes/host.md'), 'utf8'),
    queued: data.db.select().from(syncQueue).all(),
    uploads: data.db.select().from(attachmentUploadQueue).all(),
    debts: data.db.select().from(crdtBodyDebts).all(),
    docs: [...store.keys()].toSorted(),
    declined: listDeclinedRefs(asSyncDb(data.db))
  })

  const cleaned = {
    rows: ['host', 'photo'],
    indexRows: ['host', 'photo'],
    strayFile: PNG,
    hostFile: HOST_MD,
    queued: [],
    uploads: [],
    debts: [],
    docs: [],
    declined: [{ type: 'note', id: 'stray' }]
  }

  it('drops every trace of the row, queues no delete and keeps the file', async () => {
    strayVault()

    await expect(forgetStrayAttachmentRows(vault.path)).resolves.toEqual(['stray'])

    expect(state()).toEqual(cleaned)
  })

  it('changes nothing on a second run', async () => {
    strayVault()
    await forgetStrayAttachmentRows(vault.path)

    await expect(forgetStrayAttachmentRows(vault.path)).resolves.toEqual([])

    expect(state()).toEqual(cleaned)
  })

  it("takes neither the record back from a pull nor a peer's delete of it", async () => {
    strayVault()
    await forgetStrayAttachmentRows(vault.path)
    const applier = new ItemApplier(asSyncDb(data.db), vi.fn())
    const record = {
      title: 'abc-pasted',
      fileType: 'image',
      mimeType: 'image/png',
      attachmentId: 'att-stray',
      folderPath: 'attachments/host',
      clock: { windows: 3 },
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z'
    }

    const results = [
      applier.apply({
        itemId: 'stray',
        type: 'note',
        operation: 'update',
        content: new TextEncoder().encode(JSON.stringify(record)),
        clock: { windows: 3 }
      }),
      applier.apply({
        itemId: 'stray',
        type: 'note',
        operation: 'delete',
        content: new Uint8Array(),
        clock: { windows: 4 }
      })
    ]

    expect(results).toEqual(['skipped', 'skipped'])
    expect(state()).toEqual(cleaned)
  })
})
