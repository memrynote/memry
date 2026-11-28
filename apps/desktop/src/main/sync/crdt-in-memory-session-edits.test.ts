/**
 * What a launch with no CRDT store typed survives the next launch with the
 * store, once, on every device.
 *
 * The store still holds the doc of the launch before (S). The launch with no
 * store edits in memory, writes its edits to the vault file, and pushes them
 * as Yjs updates (the server, or the outbox until pushed). The next launch
 * loads S, which lacks them. It must neither show S over the file nor take
 * the file in beside the updates it pushed, which shows the text twice once
 * both merge.
 *
 * Real Y.Docs, the real provider, the real write-back and real databases. The
 * store is the in-memory map of `crdt-writeback-vault-close.test.ts`, and the
 * server is a Y.Doc that holds what the session pushed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as Y from 'yjs'
import { JournalChannels } from '@memry/contracts/ipc-channels'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { noteSnapshots } from '@memry/db-schema/schema/notes-cache'
import { SyncQueueManager } from '@memry/sync-client/queue'
import {
  markSyncEligible,
  markSyncIneligible,
  resetSyncDecision
} from '@memry/sync-client/sync-eligibility'
import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import type { VaultStatus, VaultConfig } from '@memry/contracts/vault-api'
import * as vaultStatus from '../vault/status'
import * as database from '../database'
import * as databaseClient from '../database/client'
import { registerJournalHandlers } from '../ipc/journal-handlers'
import { resolveJournalEntryId } from '../journal/create-entry'
import { getCrdtProvider, resetCrdtProvider } from './crdt-provider'
import { flushPendingWritebacks, resetWritebackState, scheduleWriteback } from './crdt-writeback'
import { feedExternalEditToCrdt } from './crdt-external-feed'
import { owesFileBody } from './crdt-owed-file-body'
import { markdownToYFragment } from './blocknote-converter'
import { getNoteCacheById, getNoteSnapshots, insertNoteCache } from '../database/queries/notes'
import { generateContentHash } from '../vault/frontmatter'
import type * as PersistenceModule from './crdt-persistence'

vi.mock('electron', () => {
  const mockWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  return {
    app: { getPath: () => '/tmp', getVersion: () => '0.0.0' },
    ipcMain: mockIpcMain,
    BrowserWindow: { getAllWindows: vi.fn(() => [mockWindow]), fromId: () => null },
    shell: { openPath: vi.fn(() => Promise.resolve('')), showItemInFolder: vi.fn() }
  }
})
vi.mock('./local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn()
}))

/** The CRDT store, in memory. `locked`: an open finds no store, a launch with none. */
const store = vi.hoisted(() => ({
  updates: new Map<string, Uint8Array[]>(),
  queues: [] as Promise<unknown>[],
  locked: false
}))
vi.mock('./crdt-persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof PersistenceModule>()
  return {
    ...actual,
    openCrdtPersistence: async () => {
      if (store.locked) return null
      const queue = store.queues.push(Promise.resolve()) - 1
      const transact = <T>(call: () => Promise<T>): Promise<T> => {
        const run = store.queues[queue].then(call)
        store.queues[queue] = run.catch(() => {})
        return run
      }
      return {
        getYDoc: (noteId: string) =>
          transact(async () => {
            const doc = new Y.Doc()
            for (const update of store.updates.get(noteId) ?? []) Y.applyUpdate(doc, update)
            return doc
          }),
        storeUpdate: (noteId: string, update: Uint8Array) =>
          transact(async () => {
            store.updates.set(noteId, [...(store.updates.get(noteId) ?? []), update])
          }),
        flushDocument: () => transact(async () => {}),
        clearDocument: (noteId: string) =>
          transact(async () => {
            store.updates.delete(noteId)
          }),
        destroy: () => transact(async () => {}),
        getMeta: () => transact(async () => undefined),
        setMeta: () => transact(async () => {})
      }
    }
  }
})
vi.mock('./crdt-store-path', () => ({
  prepareVaultCrdtStore: async () => ({ storagePath: '/unused', vaultUuid: 'vault-a' })
}))
vi.mock('./crdt-store-epoch', () => ({ reconcileCrdtStoreEpoch: async () => false }))

const DATE = '2026-05-10'
const EDITOR_WINDOW = 7
const BODY = 'From A.'
/** What the launch with no store types, and the text every assertion counts. */
const TYPED = ' Typed in memory.'
const MARKER = TYPED.trim()
/** A peer's edit the server holds, which no device of this test typed. */
const PEER = ' Peer edit.'

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1

// oxlint-disable-next-line typescript/no-base-to-string -- Y.XmlFragment toString returns the document text
const fragmentOf = (doc: Y.Doc): string => doc.getXmlFragment(CRDT_FRAGMENT_NAME).toString()

interface OpenVault {
  vault: TestVaultResult
  dataDb: TestDatabaseResult
  indexDb: TestDatabaseResult
}

function bind(open: OpenVault): void {
  vi.spyOn(vaultStatus, 'getStatus').mockReturnValue({
    isOpen: true,
    path: open.vault.path,
    isIndexing: false,
    indexProgress: 100,
    error: null
  } satisfies VaultStatus)
  vi.spyOn(vaultStatus, 'getConfig').mockReturnValue({
    excludePatterns: ['.git', 'node_modules', '.trash'],
    defaultNoteFolder: 'notes',
    journalFolder: 'journal',
    journalDateFormat: 'YYYY-MM-DD',
    attachmentsFolder: 'attachments'
  } satisfies VaultConfig)
  vi.spyOn(database, 'getDatabase').mockReturnValue(asClientDb(open.dataDb.db))
  vi.spyOn(database, 'getIndexDatabase').mockReturnValue(open.indexDb.db)
  vi.spyOn(databaseClient, 'getDatabase').mockReturnValue(asClientDb(open.dataDb.db))
  vi.spyOn(databaseClient, 'getIndexDatabase').mockReturnValue(open.indexDb.db)
}

function firstText(node: Y.XmlFragment | Y.XmlElement): Y.XmlText {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) return child
    if (child instanceof Y.XmlElement) return firstText(child)
  }
  throw new Error('no text in the doc')
}

/** A keystroke from the editor window, sent as `crdt:apply-update` sends it. */
function type(noteId: string, text: string): void {
  const doc = getCrdtProvider().getDoc(noteId) as Y.Doc
  const editor = new Y.Doc()
  Y.applyUpdate(editor, Y.encodeStateAsUpdate(doc))
  const node = firstText(editor.getXmlFragment(CRDT_FRAGMENT_NAME))
  node.insert(node.length, text)
  const update = Y.encodeStateAsUpdate(editor, Y.encodeStateVector(doc))
  getCrdtProvider().applyIpcUpdate(noteId, update, EDITOR_WINDOW)
}

/** Advances the fake clock one step, then lets the real I/O between its timers run. */
async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(250)
  await new Promise((resolve) => setImmediate(resolve))
}

/** Runs the fake clock until `work` settles. */
async function settle<T>(work: Promise<T>): Promise<T> {
  const finished = work.then(
    () => true,
    () => true
  )
  let settled = false
  while (!settled) settled = await Promise.race([finished, tick().then(() => false)])
  return work
}

/** Lets the work a failed test left running end before the next test starts. */
async function drainLeftovers(): Promise<void> {
  const drained = { done: false }
  void Promise.allSettled([flushPendingWritebacks(), ...store.queues]).then(
    () => (drained.done = true)
  )
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  for (let step = 0; step < 400 && !drained.done; step++) await tick()
}

/** The next launch: the process ended, and the store opens afresh with what it holds. */
async function restart(): Promise<void> {
  resetWritebackState()
  resetCrdtProvider()
  store.queues = []
  await getCrdtProvider().initPersistence()
}

describe('what a launch with no CRDT store typed, in the next launch with the store', () => {
  let vaultA: OpenVault

  const dayFile = (): string => path.join(vaultA.vault.path, 'journal', `${DATE}.md`)
  const fileText = (): string => fs.readFileSync(dayFile(), 'utf8')
  const row = (id: string) => getNoteCacheById(vaultA.indexDb.db, id)
  const versions = (id: string) => getNoteSnapshots(vaultA.indexDb.db, id)
  /** The versions kept since `before`, a list of ids taken earlier. */
  const keptSince = (id: string, before: string[]) =>
    versions(id).filter((version) => !before.includes(version.id))
  const versionIds = (id: string): string[] => versions(id).map((version) => version.id)
  const queue = (): SyncQueueManager => new SyncQueueManager(asClientDb(vaultA.dataDb.db))

  /** The server answers a merge with its state the doc lacks, as the runtime's pull does. */
  const mergeFrom =
    (server: Y.Doc) =>
    async (noteId: string): Promise<boolean> => {
      const provider = getCrdtProvider()
      const doc = provider.getDoc(noteId) as Y.Doc
      provider.applyRemoteUpdate(noteId, Y.encodeStateAsUpdate(server, Y.encodeStateVector(doc)))
      return true
    }

  /** The sync runtime started: its merge and its answers about the server body. */
  function wireRuntime(server: Y.Doc): void {
    markSyncEligible()
    const provider = getCrdtProvider()
    provider.setRemoteMerge(mergeFrom(server))
    provider.setRemoteBodyQuery({
      hasUnmerged: () => false,
      isStuck: () => false,
      signedOut: () => false,
      vaultLocked: () => false,
      neverSynced: () => false
    })
  }

  const withUpdate = (base: Uint8Array, update: Uint8Array): Y.Doc => {
    const server = new Y.Doc()
    Y.applyUpdate(server, base)
    Y.applyUpdate(server, update)
    return server
  }

  /** Lets the write-back passes the open scheduled write, so none can hide an overwrite. */
  const settleWritebacks = (): Promise<void> => settle(flushPendingWritebacks())

  interface Session {
    id: string
    /** The server's state after the launch with the store: what S holds. */
    base: Uint8Array
    /** What the launch with no store typed, as the Yjs update it pushes. */
    update: Uint8Array
  }

  /**
   * (1) A launch with the store writes the body and stores it (S). (2) A
   * launch with no store opens the note for the editor (the merge applies the
   * server's state, which equals S) and types into it; the write-back writes
   * the file. Resolves with the provider still in that session.
   */
  async function sessionWithNoStore(): Promise<Session> {
    await invokeHandler(JournalChannels.invoke.CREATE_ENTRY, { date: DATE, content: BODY })
    const id = resolveJournalEntryId(DATE)
    // The create's index row lands through the projection lane, which this suite does not run.
    insertNoteCache(vaultA.indexDb.db, {
      id,
      path: `journal/${DATE}.md`,
      title: DATE,
      date: DATE,
      createdAt: '2026-05-10T00:00:00.000Z',
      modifiedAt: '2026-05-10T00:00:00.000Z',
      contentHash: generateContentHash(fileText())
    })
    const seeded = getCrdtProvider().getDoc(id) as Y.Doc
    await markdownToYFragment(BODY, seeded.getXmlFragment(CRDT_FRAGMENT_NAME))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await settle(flushPendingWritebacks())
    await settle(getCrdtProvider().close(id))
    await Promise.all(store.queues)
    const stored = Y.mergeUpdates(store.updates.get(id) ?? [])
    const base = new Y.Doc()
    Y.applyUpdate(base, stored)
    expect(fragmentOf(base)).toContain(BODY)

    store.locked = true
    await restart()
    const provider = getCrdtProvider()
    expect(provider.hasPersistence()).toBe(false)
    const doc = await settle(provider.openForEditor(id, EDITOR_WINDOW, mergeFrom(base)))
    type(id, TYPED)
    await vi.waitFor(
      async () => {
        await tick()
        expect(fileText()).toContain(MARKER)
        expect(row(id)?.contentHash).toBe(generateContentHash(fileText()))
      },
      { timeout: 10_000, interval: 10 }
    )
    await settle(flushPendingWritebacks())
    const update = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(base))
    // The versions the two sessions kept are not what the tests count: a
    // version of the same bytes is never kept twice.
    vaultA.indexDb.db.delete(noteSnapshots).run()
    // The outbox rows are each test's own: what the session pushed, or not.
    queue().removeNoteBody(id)
    return { id, base: stored, update }
  }

  /** (3) The launch with the store, which still holds the older S. */
  async function relaunchWithStore(): Promise<void> {
    store.locked = false
    await restart()
    expect(getCrdtProvider().hasPersistence()).toBe(true)
  }

  beforeEach(async () => {
    store.updates.clear()
    store.queues = []
    store.locked = false
    vaultA = {
      vault: createTestVault('in-memory-session-edits'),
      dataDb: createTestDataDb(),
      indexDb: createTestIndexDb()
    }
    bind(vaultA)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {})
    registerJournalHandlers()
    await getCrdtProvider().initPersistence()
  })

  afterEach(async () => {
    await drainLeftovers()
    resetWritebackState()
    resetCrdtProvider()
    markSyncIneligible()
    resetSyncDecision()
    vi.useRealTimers()
    resetIpcMocks()
    vi.restoreAllMocks()
    vaultA.indexDb.close()
    vaultA.dataDb.close()
    vaultA.vault.cleanup()
  })

  it('marks every file a launch with no store writes as unstored, and a close keeps the mark', async () => {
    const { id } = await sessionWithNoStore()
    expect.soft(row(id)?.pendingWriteHash).toMatch(/^unstored-file:/)

    await settle(getCrdtProvider().close(id))

    expect(row(id)?.pendingWriteHash).toMatch(/^unstored-file:/)
  })

  it('shows the typed text once when the server already holds it', async () => {
    const { id, base, update } = await sessionWithNoStore()
    const versionsBefore = versionIds(id)
    await relaunchWithStore()
    const server = withUpdate(base, update)
    wireRuntime(server)

    const provider = getCrdtProvider()
    const doc = await settle(provider.openForEditor(id, EDITOR_WINDOW, mergeFrom(server)))
    await settleWritebacks()

    expect.soft(occurrences(fragmentOf(doc), MARKER)).toBe(1)
    expect.soft(occurrences(fileText(), MARKER)).toBe(1)
    expect.soft(row(id)?.pendingWriteHash).toBeNull()
    expect.soft(owesFileBody(id)).toBe(false)
    expect.soft(versionIds(id)).toEqual(versionsBefore)
    expect(provider.remoteBodyWait(id)).toBeNull()
  })

  it('keeps the file and waits for the merge when a tab opens before the runtime wires it', async () => {
    const { id, base, update } = await sessionWithNoStore()
    await relaunchWithStore()
    const server = withUpdate(base, update)
    const provider = getCrdtProvider()

    const doc = await settle(provider.openForEditor(id, EDITOR_WINDOW, null))

    expect.soft(provider.remoteBodyWait(id)).toBe('merging')
    expect.soft(occurrences(fileText(), MARKER)).toBe(1)
    expect.soft(owesFileBody(id)).toBe(true)

    // A write-back pass leaves the file the doc has not taken alone.
    scheduleWriteback(id, doc, 'local')
    await settleWritebacks()
    expect.soft(occurrences(fileText(), MARKER)).toBe(1)

    // A body writer's feed is refused too: the stored body lacks text the
    // file and the server both hold.
    const waiting = fragmentOf(doc)
    expect.soft(await settle(feedExternalEditToCrdt(id, 'Rewritten by a tool.'))).toBe(false)
    expect.soft(fragmentOf(doc)).toBe(waiting)

    provider.setRemoteMerge(mergeFrom(server))
    await settle(provider.resumeWaitingEditorDocs())
    await settleWritebacks()

    expect.soft(provider.remoteBodyWait(id)).toBeNull()
    expect.soft(occurrences(fragmentOf(doc), MARKER)).toBe(1)
    expect(occurrences(fileText(), MARKER)).toBe(1)
  })

  for (const [when, wire] of [
    ['before the runtime wires its merge', false],
    ['while the server lacks the update', true]
  ] as const) {
    it(`takes the queued update, not the file, and shows the typed text once ${when}`, async () => {
      const { id, base, update } = await sessionWithNoStore()
      await relaunchWithStore()
      queue().enqueueNoteBody(id, Buffer.from(update).toString('base64'))
      const rowsBefore = queue().takeNoteBodyRows(id, 100).length
      expect(rowsBefore).toBe(1)
      const provider = getCrdtProvider()
      const server = new Y.Doc()
      Y.applyUpdate(server, base)
      if (wire) wireRuntime(server)

      const doc = await settle(
        provider.openForEditor(id, EDITOR_WINDOW, wire ? mergeFrom(server) : null)
      )
      await settleWritebacks()

      expect.soft(occurrences(fragmentOf(doc), MARKER)).toBe(1)
      expect.soft(provider.remoteBodyWait(id)).toBeNull()
      expect.soft(queue().takeNoteBodyRows(id, 100)).toHaveLength(rowsBefore)

      // The push lands, and the server echoes the update back.
      provider.applyRemoteUpdate(id, update)
      await settleWritebacks()

      expect.soft(occurrences(fragmentOf(doc), MARKER)).toBe(1)
      expect(occurrences(fileText(), MARKER)).toBe(1)
    })
  }

  it('takes the file in once and keeps the merged body as a version when the push never landed', async () => {
    const { id, base } = await sessionWithNoStore()
    const versionsBefore = versionIds(id)
    await relaunchWithStore()
    // The server holds a peer's edit this device never saw, and none of TYPED.
    const server = new Y.Doc()
    Y.applyUpdate(server, base)
    const peerNode = firstText(server.getXmlFragment(CRDT_FRAGMENT_NAME))
    peerNode.insert(peerNode.length, PEER)
    wireRuntime(server)

    const provider = getCrdtProvider()
    const doc = await settle(provider.openForEditor(id, EDITOR_WINDOW, mergeFrom(server)))
    await settleWritebacks()

    expect.soft(occurrences(fragmentOf(doc), MARKER)).toBe(1)
    expect.soft(occurrences(fileText(), MARKER)).toBe(1)
    expect.soft(provider.remoteBodyWait(id)).toBeNull()
    expect.soft(owesFileBody(id)).toBe(false)
    const kept = keptSince(id, versionsBefore)
    expect(kept).toHaveLength(1)
    expect(kept[0].fileContent).toContain(BODY)
    expect(kept[0].fileContent).toContain(PEER.trim())
    expect(kept[0].fileContent).not.toContain(MARKER)
  })

  it('takes the file in at open on an install that does not sync, keeping the older body as a version', async () => {
    const { id } = await sessionWithNoStore()
    const versionsBefore = versionIds(id)
    await relaunchWithStore()
    markSyncIneligible()

    const provider = getCrdtProvider()
    const doc = await settle(provider.openForEditor(id, EDITOR_WINDOW, null))
    await settleWritebacks()

    expect.soft(occurrences(fragmentOf(doc), MARKER)).toBe(1)
    expect.soft(occurrences(fileText(), MARKER)).toBe(1)
    expect.soft(provider.remoteBodyWait(id)).toBeNull()
    const kept = keptSince(id, versionsBefore)
    expect(kept).toHaveLength(1)
    expect(kept[0].fileContent).toContain(BODY)
    expect(kept[0].fileContent).not.toContain(MARKER)
  })

  it('takes the file in once the runtime settles that the install does not sync', async () => {
    const { id } = await sessionWithNoStore()
    const versionsBefore = versionIds(id)
    await relaunchWithStore()
    const provider = getCrdtProvider()

    // The tab restores before the runtime decides: the doc waits.
    const doc = await settle(provider.openForEditor(id, EDITOR_WINDOW, null))
    expect.soft(provider.remoteBodyWait(id)).toBe('merging')

    markSyncIneligible()
    await settle(provider.settleUnwiredEditorDocs())
    await settleWritebacks()

    expect.soft(provider.remoteBodyWait(id)).toBeNull()
    expect.soft(occurrences(fragmentOf(doc), MARKER)).toBe(1)
    expect.soft(occurrences(fileText(), MARKER)).toBe(1)
    const kept = keptSince(id, versionsBefore)
    expect(kept).toHaveLength(1)
    expect(kept[0].fileContent).toContain(BODY)
    expect(kept[0].fileContent).not.toContain(MARKER)
  })
})
