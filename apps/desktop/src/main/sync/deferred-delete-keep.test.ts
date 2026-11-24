/**
 * A note delete this device sends after the fact keeps a peer's text the
 * deleting device never held (chapter 05 §5.8, #3037, #5681). The CLI queues a
 * delete with no body vector (#5661), and desktop sends it later: at the next
 * sync runtime start, or when its watcher sees the CLI's unlink. Desktop's own
 * delete raised while the runtime is down is sent later the same way. Its
 * `deletedAt` is the push time, so without the vector of the doc this device
 * held, a peer reads text pushed long before as seen and makes no copy.
 *
 * Device A runs the real CLI delete, CRDT provider (its doc store a map), sync
 * queue and note sync service. The payload A queues is then pulled through the
 * real ItemApplier on device B, which holds text A never received.
 *
 * @module sync/deferred-delete-keep.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as Y from 'yjs'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { syncPendingDeletes } from '@memry/db-schema/schema/sync-pending-deletes'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { markSyncEligible, markSyncIneligible } from '@memry/sync-client/sync-eligibility'
import { createTestVault } from '@tests/utils/test-vault'
import {
  asClientDb,
  asSyncDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { deleteNoteRowQueuingSyncDelete } from '../../../../cli/src/app-core/note-sync-delete'

const store = vi.hoisted(() => new Map<string, Uint8Array[]>())
const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false, getVersion: () => '0.0.0' },
  BrowserWindow: { fromId: () => null, getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  shell: { trashItem: vi.fn() }
}))
vi.mock('../lib/logger', () => ({ createLogger: () => logger }))
vi.mock('./crdt-persistence', async () => {
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
vi.mock('./crdt-store-epoch', () => ({ reconcileCrdtStoreEpoch: async () => {} }))
vi.mock('./crdt-store-path', () => ({
  prepareVaultCrdtStore: async () => ({ storagePath: '/tmp/crdt', vaultUuid: 'vault-1' })
}))
vi.mock('../store', () => ({ recordCrdtPersistenceOutcome: () => 0 }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))
vi.mock('../projections', () => ({
  flushProjectionEvents: vi.fn(),
  publishProjectionEvent: vi.fn()
}))
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
vi.mock('../vault/status', async () => await import('../vault/index'))
vi.mock('../vault/index', () => ({
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
import { getStatus } from '../vault/index'
import { getCrdtProvider, resetCrdtProvider } from './crdt-provider'
import { ItemApplier } from './apply-item'
import { beginPageApply, _resetBulkApplyForTests } from './bulk-apply'
import { recordNoteBodyPush } from './note-body-push-record'
import { initNoteSyncService, resetNoteSyncService } from './note-sync'
import { initJournalSyncService, resetJournalSyncService } from './journal-sync'
import { flushPendingLocalDeletes } from './local-mutations'
import { coverQueuedContentDeletes } from './local-doc-delete'
import { syncNoteDelete } from '../notes/runtime-effects'
import { enqueueJournalDelete } from '../journal/runtime-effects'

const NOTE = {
  id: 'abcdefghijkl',
  type: 'note',
  path: 'notes/Plans.md',
  title: 'Plans',
  journalDate: null,
  copy: { title: 'Plans (kept from deleted note)', content: 'Pushed at 9:30\n' }
} as const
const DAY = {
  id: 'j2026-10-09',
  type: 'journal',
  path: 'journal/2026-10-09.md',
  title: '2026-10-09',
  journalDate: '2026-10-09',
  copy: { title: 'Journal 2026-10-09 (kept from deleted day)', content: 'Pushed at 9:30' }
} as const
type Item = typeof NOTE | typeof DAY
const DEVICE_A = 'a'
// A pushes the delete at 11:00; B's text reached the server at 9:30.
const PUSHED_MS = Date.parse('2026-10-09T11:00:00.000Z')
const PEER_TEXT_CONFIRMED_MS = PUSHED_MS - 90 * 60_000

/** A Yjs update with `text` from Yjs client `client`. */
const bodyUpdate = (client: number, text: string): Uint8Array => {
  const doc = new Y.Doc()
  doc.clientID = client
  doc.getText('t').insert(0, text)
  return Y.encodeStateAsUpdate(doc)
}
// The body both devices held before A went offline, and B's text after.
const held = bodyUpdate(1, 'Old')
const peerText = bodyUpdate(2, 'Pushed at 9:30')

describe('a note delete sent after the fact, pulled by a peer with text it never sent (#5681)', () => {
  let vault: ReturnType<typeof createTestVault>
  let deviceA: TestDatabaseResult
  let deviceB: TestDatabaseResult
  let index: TestDatabaseResult
  let queue: SyncQueueManager

  const actAs = (device: TestDatabaseResult): void => {
    vi.mocked(getDatabase).mockReturnValue(asClientDb(device.db))
    vi.mocked(getClientDatabase).mockReturnValue(asClientDb(device.db))
  }

  beforeEach(async () => {
    _resetBulkApplyForTests()
    vault = createTestVault('deferred-delete-keep')
    deviceA = createTestDataDb()
    deviceB = createTestDataDb()
    index = createTestIndexDb()
    actAs(deviceA)
    vi.mocked(getIndexDatabase).mockReturnValue(index.db)
    vi.mocked(getClientIndexDatabase).mockReturnValue(index.db)
    vi.mocked(getStatus).mockReturnValue({
      isOpen: true,
      path: vault.path,
      isIndexing: false,
      indexProgress: 100,
      error: null
    })
    await getCrdtProvider().initPersistence(vault.path)
    queue = new SyncQueueManager(asSyncDb(deviceA.db))
    asClientDb(deviceA.db)
      .insert(syncDevices)
      .values({
        id: DEVICE_A,
        name: 'A',
        platform: 'darwin',
        appVersion: '2026.10.1',
        linkedAt: new Date(),
        isCurrentDevice: true,
        signingPublicKey: 'pk'
      })
      .run()
    markSyncEligible()
  })

  afterEach(() => {
    resetNoteSyncService()
    resetJournalSyncService()
    resetCrdtProvider()
    markSyncIneligible()
    _resetBulkApplyForTests()
    store.clear()
    index.close()
    deviceA.close()
    deviceB.close()
    vault.cleanup()
    vi.clearAllMocks()
  })

  /** The synced item on `device`, with its file, at record clock {a:4}. */
  function seedNote(device: TestDatabaseResult, body: string, item: Item = NOTE): void {
    asClientDb(device.db)
      .insert(noteMetadata)
      .values({
        id: item.id,
        path: item.path,
        title: item.title,
        journalDate: item.journalDate,
        fileType: 'markdown',
        clock: { [DEVICE_A]: 4 },
        createdAt: '2026-10-01T08:00:00.000Z',
        modifiedAt: '2026-10-01T08:00:00.000Z'
      })
      .run()
    fs.mkdirSync(path.dirname(path.join(vault.path, item.path)), { recursive: true })
    fs.writeFileSync(path.join(vault.path, item.path), body)
  }

  /** What the CLI's `notes delete` does to A: the file, then the row and its queued delete. */
  function cliDelete(item: Item = NOTE): void {
    fs.rmSync(path.join(vault.path, item.path))
    deleteNoteRowQueuingSyncDelete(asClientDb(deviceA.db), item.id)
  }

  const startNoteSync = (): void => {
    initNoteSyncService({ queue, getDeviceId: () => DEVICE_A })
  }

  /** The delete A queued for the server. */
  const queuedDelete = (item: Item = NOTE): { payload: string; clock: Record<string, number> } => {
    const items = queue.peek(10).filter((i) => i.itemId === item.id && i.operation === 'delete')
    expect(items).toHaveLength(1)
    const payload = items[0].payload
    return { payload, clock: (JSON.parse(payload) as { clock: Record<string, number> }).clock }
  }

  /** B pulls A's delete, pushed at 11:00, over text B pushed at 9:30. Returns B's inbox. */
  async function peerPulls(
    sent: { payload: string; clock: Record<string, number> },
    item: Item = NOTE
  ) {
    actAs(deviceB)
    seedNote(deviceB, 'Pushed at 9:30\n', item)
    recordNoteBodyPush(item.id, 'confirmed', PEER_TEXT_CONFIRMED_MS, asClientDb(deviceB.db), [
      held,
      peerText
    ])
    const page = beginPageApply(asSyncDb(deviceB.db))
    const result = new ItemApplier(asSyncDb(deviceB.db), vi.fn()).apply(
      {
        itemId: item.id,
        type: item.type,
        operation: 'delete',
        content: new TextEncoder().encode(sent.payload),
        clock: sent.clock,
        deletedAt: PUSHED_MS / 1000
      },
      page
    )
    page.commit()
    await page.flushFiles()
    expect(result).toBe('applied')
    return asClientDb(deviceB.db)
      .select({ title: inboxItems.title, content: inboxItems.content })
      .from(inboxItems)
      .all()
  }

  const keptCopy = [NOTE.copy]

  it('keeps the text when the CLI deleted the note while desktop was closed', async () => {
    seedNote(deviceA, 'Old\n')
    store.set(NOTE.id, [held])
    cliDelete()

    // The next sync runtime start, before its first pull.
    await coverQueuedContentDeletes(asSyncDb(deviceA.db))
    startNoteSync()
    flushPendingLocalDeletes(asSyncDb(deviceA.db))

    const sent = queuedDelete()
    expect(sent.clock).toEqual({ [DEVICE_A]: 5 })
    expect(await peerPulls(sent)).toEqual(keptCopy)
    expect(store.has(NOTE.id)).toBe(false)
  })

  it('keeps the text when the CLI deleted the note while desktop ran', async () => {
    seedNote(deviceA, 'Old\n')
    store.set(NOTE.id, [held])
    startNoteSync()
    cliDelete()

    // The watcher's unlink of the CLI's file, which finds no row.
    await syncNoteDelete(NOTE.id)

    const sent = queuedDelete()
    expect(sent.clock).toEqual({ [DEVICE_A]: 5 })
    expect(store.has(NOTE.id)).toBe(false)
    expect(await peerPulls(sent)).toEqual(keptCopy)
  })

  it('keeps the text when the CLI deleted a journal day while desktop ran', async () => {
    seedNote(deviceA, 'Old\n', DAY)
    store.set(DAY.id, [held])
    startNoteSync()
    initJournalSyncService({ queue, getDeviceId: () => DEVICE_A })
    cliDelete(DAY)

    // With no row, the raise queues a delete ticked from no clock; the CLI's replaces it.
    await enqueueJournalDelete(DAY.id, DAY.journalDate)

    const sent = queuedDelete(DAY)
    expect(sent.clock).toEqual({ [DEVICE_A]: 5 })
    expect(await peerPulls(sent, DAY)).toEqual([DAY.copy])
  })

  it("keeps the text when desktop's own delete waited for the sync runtime", async () => {
    seedNote(deviceA, 'Old\n')
    store.set(NOTE.id, [held])

    // Deleted with the runtime down: the doc is purged with the note.
    await syncNoteDelete(NOTE.id)
    asClientDb(deviceA.db).delete(noteMetadata).run()
    expect(store.has(NOTE.id)).toBe(false)

    await coverQueuedContentDeletes(asSyncDb(deviceA.db))
    startNoteSync()
    flushPendingLocalDeletes(asSyncDb(deviceA.db))

    const sent = queuedDelete()
    expect(sent.clock).toEqual({ [DEVICE_A]: 5 })
    expect(await peerPulls(sent)).toEqual(keptCopy)
  })

  it('still sends the delete when this device holds no doc for the note, and says so', async () => {
    seedNote(deviceA, 'Old\n')
    cliDelete()

    await coverQueuedContentDeletes(asSyncDb(deviceA.db))
    startNoteSync()
    flushPendingLocalDeletes(asSyncDb(deviceA.db))

    const sent = queuedDelete()
    expect(sent.clock).toEqual({ [DEVICE_A]: 5 })
    expect(JSON.parse(sent.payload)).not.toHaveProperty('bodyStateVector')
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no body vector'),
      expect.objectContaining({ type: 'note', itemId: NOTE.id })
    )
    expect(asClientDb(deviceA.db).select().from(syncPendingDeletes).all()).toHaveLength(1)
  })
})
