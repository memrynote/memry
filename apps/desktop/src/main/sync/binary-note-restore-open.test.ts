import * as Y from 'yjs'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { upsertNoteMetadata } from '@memry/storage-data'
import { attachmentEvents } from '@memry/sync-client/attachment-events'
import {
  markDownloadSucceeded,
  resetAttachmentDownloadSession
} from '@memry/sync-client/attachment-download-state'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'

/**
 * A shipped build's write-back put a binary note's doc as markdown over its
 * PNG and saved the row as markdown (#5412). The restore downloads the PNG
 * back under that row; then the note's doc opens and a remote body lands. The
 * real CRDT provider and write-back must take nothing from the restored file
 * and write nothing over it (#5415).
 */

const h = vi.hoisted(() => ({
  store: new Map<string, Uint8Array[]>(),
  indexDb: null as unknown,
  vaultRoot: ''
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0' },
  BrowserWindow: { fromId: () => null, getAllWindows: () => [] }
}))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
vi.mock('./crdt-persistence', async () => {
  const Yjs = await import('yjs')
  return {
    openCrdtPersistence: async () => ({
      getYDoc: async (noteId: string) => {
        const doc = new Yjs.Doc()
        for (const update of h.store.get(noteId) ?? []) Yjs.applyUpdate(doc, update)
        return doc
      },
      storeUpdate: async (noteId: string, update: Uint8Array) => {
        h.store.set(noteId, [...(h.store.get(noteId) ?? []), update])
      },
      flushDocument: async () => {},
      clearDocument: async (noteId: string) => {
        h.store.delete(noteId)
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
vi.mock('../agent/storage/vault-id', () => ({ getOrCreateVaultUuid: () => 'vault-1' }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))
vi.mock('../database/client', () => ({
  getDatabase: () => ({}),
  getIndexDatabase: () => h.indexDb,
  isDatabaseInitialized: () => true
}))
vi.mock('../database', () => ({ getDatabase: () => ({}), getIndexDatabase: () => h.indexDb }))
vi.mock('../vault/note-snapshots', async () => await import('../vault/notes'))
vi.mock('../vault/notes-versions', async () => await import('../vault/notes'))
vi.mock('../vault/notes-crud', async () => await import('../vault/notes'))
vi.mock('../vault/notes-io', async () => await import('../vault/notes'))
vi.mock('../vault/notes', () => ({
  getVaultRoot: () => h.vaultRoot,
  toAbsolutePath: (relative: string) => path.join(h.vaultRoot, relative),
  maybeCreateSignificantSnapshot: () => null,
  createSnapshot: () => null
}))
vi.mock('../vault/journal', () => ({ getJournalPath: vi.fn() }))
vi.mock('../vault/note-sync', () => ({
  syncNoteToCache: vi.fn(),
  deleteNoteFromCache: vi.fn(),
  refusesCaseTwinFile: () => false
}))
vi.mock('../vault/attachment-rename-reconcile', () => ({ reconcileRenamedAttachments: vi.fn() }))
vi.mock('../projections', () => ({ flushProjectionEvents: vi.fn() }))
vi.mock('../notes/note-date-reminders', () => ({
  syncNoteDateReminders: vi.fn(),
  clearNoteDateReminders: vi.fn()
}))
vi.mock('@memry/app-core/reminders', () => ({ createRemindersService: vi.fn() }))
vi.mock('./local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn()
}))

import { getCrdtProvider, resetCrdtProvider } from './crdt-provider'
import { hasPendingWriteback, resetWritebackState } from './crdt-writeback'
import { markdownToYFragment, yDocToMarkdown } from './blocknote-converter'
import { generateContentHash } from '../vault/frontmatter'
import { insertNoteCache } from '@main/database/queries/notes'
import { restoreOverwrittenBinaryNotesWith } from './binary-note-restore'

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
])
const ID = 'png-restored'
const NOTE_PATH = 'Images/Sunset.png'

function findText(fragment: Y.XmlFragment, needle: string): Y.XmlText {
  const stack: Array<Y.XmlElement | Y.XmlFragment | Y.XmlText> = [fragment]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node instanceof Y.XmlText) {
      if (node.toString().includes(needle)) return node
      continue
    }
    stack.push(...(node.toArray() as Array<Y.XmlElement | Y.XmlText>))
  }
  throw new Error(`no text holding ${needle}`)
}

/** An edit from another device, made on a copy of `doc`. */
function remoteEditOf(doc: Y.Doc, find: string, insert: string): Uint8Array {
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  const seen = Y.encodeStateVector(copy)
  const text = findText(copy.getXmlFragment(CRDT_FRAGMENT_NAME), find)
  text.insert(text.length, insert)
  return Y.encodeStateAsUpdate(copy, seen)
}

describe('doc open after a binary note restore (#5415)', () => {
  let dataDb: TestDatabaseResult
  const queue = { enqueue: vi.fn(), enqueueFullState: vi.fn(), dropNote: vi.fn() }
  const downloader = (event: {
    noteId: string
    attachmentId: string
    diskPath: string
    landed?: () => void
  }): void => {
    fs.writeFileSync(`${event.diskPath}.part`, PNG)
    fs.renameSync(`${event.diskPath}.part`, event.diskPath)
    markDownloadSucceeded(asClientDb(dataDb.db), event.noteId, event.attachmentId)
    event.landed?.()
  }

  beforeEach(() => {
    h.vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-5415-open-'))
    h.indexDb = createTestIndexDb().db
    h.store.clear()
    dataDb = createTestDataDb()
    attachmentEvents.onDownloadNeeded(downloader)
  })

  afterEach(() => {
    attachmentEvents.offDownloadNeeded(downloader)
    resetAttachmentDownloadSession()
    resetCrdtProvider()
    resetWritebackState()
    vi.clearAllMocks()
    dataDb.close()
    fs.rmSync(h.vaultRoot, { recursive: true, force: true })
  })

  it('takes nothing from the restored PNG and writes nothing over it', async () => {
    // State a shipped build left: the server body in the store, written as
    // markdown over the PNG, and both rows saying markdown.
    const author = new Y.Doc()
    await markdownToYFragment('# Sunset\n\nA body.', author.getXmlFragment(CRDT_FRAGMENT_NAME))
    const body = (await yDocToMarkdown(author, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH }))!
    h.store.set(ID, [Y.encodeStateAsUpdate(author)])
    const abs = path.join(h.vaultRoot, NOTE_PATH)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
    insertNoteCache(h.indexDb as never, {
      id: ID,
      path: NOTE_PATH,
      title: 'Sunset',
      fileType: 'markdown',
      localOnly: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      contentHash: generateContentHash(body),
      pendingWriteHash: null
    })
    upsertNoteMetadata(asClientDb(dataDb.db), {
      id: ID,
      path: NOTE_PATH,
      title: 'Sunset',
      fileType: 'markdown',
      attachmentId: 'att-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z'
    })

    expect(
      await restoreOverwrittenBinaryNotesWith({
        db: asClientDb(dataDb.db),
        vaultPath: h.vaultRoot
      })
    ).toEqual({ requested: 1 })
    expect(fs.readFileSync(abs)).toEqual(PNG)

    const provider = getCrdtProvider()
    await provider.init(queue as never, vi.fn())
    const doc = await provider.open(ID, 1)
    provider.applyRemoteUpdate(ID, remoteEditOf(doc, 'A body.', ' Remote.'))
    await provider.materialize(ID)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await vi.waitFor(() => expect(hasPendingWriteback(ID)).toBe(false), { timeout: 5000 })

    expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })).toBe(
      body.replace('A body.', 'A body. Remote.')
    )
    // The server body and the remote update; no ingest of the file.
    expect(h.store.get(ID)).toHaveLength(2)
    expect(queue.enqueue).not.toHaveBeenCalled()
    expect(queue.enqueueFullState).not.toHaveBeenCalled()
    expect(fs.readFileSync(abs)).toEqual(PNG)
  })
})
