import * as Y from 'yjs'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as YLeveldb from 'y-leveldb'
import { CRDT_EVENTS, CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'

// The real provider and the real store open (crdt-persistence.ts) over a real
// LevelDB directory. Only the preflight child, which vitest cannot spawn, is
// faked; the slow disk is the NODE_ENV=test probe delay the e2e uses too.
const EDITOR = vi.hoisted(() => 7)
const PROBE_TIMEOUT_MS = 15_000
const PROBE_DELAY_MS = 20_000

const h = vi.hoisted(() => ({
  storeDir: '',
  preflight: { ok: true } as { ok: boolean; stage?: string; reason?: string },
  /** Store calls in order: `open`, `destroy`, and `read`/`store`/`clear` with a note id. */
  calls: [] as string[],
  handles: [] as Array<{ destroyed: boolean }>,
  /** Holds the next read of this note until `release` runs. */
  hold: null as null | { noteId: string; release: () => void; reached: () => void },
  logs: [] as Array<{ level: string; message: string; meta?: unknown }>,
  broadcasts: [] as Array<{ channel: string; payload: unknown }>,
  sent: [] as Array<{ channel: string; payload: { noteId: string; origin: string } }>,
  outcomes: [] as boolean[]
}))

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getVersion: () => '2026.9.14' },
  BrowserWindow: {
    fromId: (id: number) =>
      id === EDITOR
        ? {
            isDestroyed: () => false,
            webContents: {
              send: (channel: string, payload: { noteId: string; origin: string }) =>
                h.sent.push({ channel, payload })
            }
          }
        : null,
    getAllWindows: () => []
  }
}))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: (message: string, meta?: unknown) => h.logs.push({ level: 'info', message, meta }),
    warn: (message: string, meta?: unknown) => h.logs.push({ level: 'warn', message, meta }),
    error: (message: string, meta?: unknown) => h.logs.push({ level: 'error', message, meta })
  })
}))
vi.mock('../lib/window-broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) =>
    h.broadcasts.push({ channel, payload })
}))
vi.mock('./crdt-preflight', () => ({
  runCrdtPreflight: async () => h.preflight,
  preflightMachineFields: () => ({}),
  stripAbsolutePaths: (text: string) => text
}))
vi.mock('y-leveldb', async (importOriginal) => {
  const actual = await importOriginal<typeof YLeveldb>()
  class RecordedStore extends actual.LeveldbPersistence {
    destroyed = false
    constructor(...args: ConstructorParameters<typeof actual.LeveldbPersistence>) {
      super(...args)
      h.calls.push('open')
      h.handles.push(this)
    }
    async getYDoc(name: string): Promise<Y.Doc> {
      h.calls.push(`read:${name}`)
      const hold = h.hold
      if (hold?.noteId === name) {
        h.hold = null
        await new Promise<void>((resolve) => {
          hold.release = resolve
          hold.reached()
        })
      }
      return super.getYDoc(name)
    }
    storeUpdate(name: string, update: Uint8Array): Promise<unknown> {
      h.calls.push(`store:${name}`)
      return super.storeUpdate(name, update)
    }
    clearDocument(name: string): Promise<void> {
      h.calls.push(`clear:${name}`)
      return super.clearDocument(name)
    }
    async destroy(): Promise<void> {
      h.calls.push('destroy')
      await super.destroy()
      this.destroyed = true
    }
  }
  return { ...actual, LeveldbPersistence: RecordedStore }
})
vi.mock('./crdt-store-epoch', () => ({ reconcileCrdtStoreEpoch: async () => false }))
vi.mock('./crdt-store-path', () => ({
  prepareVaultCrdtStore: async () => ({ storagePath: h.storeDir, vaultUuid: 'vault-1' })
}))
vi.mock('../store', () => ({
  getCrdtInMemorySessions: () => 0,
  getCrdtPersistenceGuard: () => ({ sessions: 0 }),
  recordCrdtPersistenceOutcome: (healthy: boolean) => {
    h.outcomes.push(healthy)
    return healthy ? 0 : 1
  },
  recordCrdtPreflightFailure: vi.fn()
}))
vi.mock('../telemetry/track', () => ({ trackMainEvent: vi.fn() }))
vi.mock('../telemetry/redact-options', () => ({ getMainRedactOptions: () => ({}) }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn() }))
vi.mock('../database/client', () => ({
  getIndexDatabase: () => ({}),
  getDatabase: () => ({}),
  isDatabaseInitialized: () => true
}))
vi.mock('../database', () => ({ getDatabase: () => ({}), getIndexDatabase: () => ({}) }))
vi.mock('../agent/storage/vault-id', () => ({ getOrCreateVaultUuid: () => 'vault-1' }))
vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: (_db: unknown, id: string) => ({
    id,
    path: `notes/${id}.md`,
    title: id,
    fileType: 'markdown'
  }),
  updateNoteCache: vi.fn()
}))
vi.mock('@memry/storage-data', () => ({
  updateNoteMetadata: vi.fn(),
  getNoteMetadataByPath: () => undefined,
  listNoteMetadataByFoldedPath: () => []
}))
vi.mock('./local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  removePendingNoteSyncItems: vi.fn()
}))
vi.mock('@memry/sync-client/attachment-events', () => ({
  attachmentEvents: { emitSaved: vi.fn() }
}))
vi.mock('../tasks/domain', () => ({ createDesktopTasksDomain: vi.fn() }))
vi.mock('../tasks/publisher', () => ({ createTasksPublisher: vi.fn() }))
vi.mock('../vault/note-snapshots', async () => await import('../vault/notes'))
vi.mock('../vault/notes-versions', async () => await import('../vault/notes'))
vi.mock('../vault/notes-crud', async () => await import('../vault/notes'))
vi.mock('../vault/notes-io', async () => await import('../vault/notes'))
vi.mock('../vault/notes', () => ({
  getVaultRoot: () => '/vault',
  toAbsolutePath: (p: string) => path.join('/vault', p)
}))
vi.mock('./crdt-writeback-port', () => ({
  crdtWriteback: () => ({
    scheduleWriteback: () => {},
    cancelWriteback: () => {},
    flushPendingWritebacks: async () => {},
    hasArmedWritebacks: () => false,
    writeBackBeforeClose: async () => {},
    insideWritebackTurn: () => false,
    ingestOfflineEdit: async () => {},
    resetWritebackState: () => {},
    writebackNow: async () => {}
  })
}))
vi.mock('./crdt-network-update', () => ({ recordNetworkUpdate: vi.fn() }))
vi.mock('./crdt-owed-file-body', () => ({
  owesFileBody: () => false,
  clearOwedFileBody: vi.fn(),
  recordOwedFileBody: vi.fn()
}))

import { CrdtProvider, _resetCrdtSessionOutcomeForTests } from './crdt-provider'

/** The store without the recording above: the test's own handles stay out of `h.calls`. */
const { LeveldbPersistence } = await vi.importActual<typeof YLeveldb>('y-leveldb')

const NOTE = 'note-a'
const ipc = { source: 'ipc', windowId: EDITOR }

/** A body of one root block group holding `text`, the shape a seed or an editor writes. */
function writeBody(doc: Y.Doc, text: string, origin: unknown = 'local'): void {
  doc.transact(() => {
    const paragraph = new Y.XmlElement('paragraph')
    paragraph.insert(0, [new Y.XmlText(text)])
    const container = new Y.XmlElement('blockContainer')
    container.insert(0, [paragraph])
    const group = new Y.XmlElement('blockGroup')
    group.insert(0, [container])
    doc.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [group])
  }, origin)
}

/** Types `text` at the end of the body's last text node, as an editor does. */
function type(doc: Y.Doc, text: string, origin: unknown = ipc): void {
  const texts: Y.XmlText[] = []
  const stack: Array<Y.XmlElement | Y.XmlFragment | Y.XmlText> = [
    doc.getXmlFragment(CRDT_FRAGMENT_NAME)
  ]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node instanceof Y.XmlText) texts.push(node)
    else stack.push(...(node.toArray() as Array<Y.XmlElement | Y.XmlText>))
  }
  const last = texts.at(-1)
  if (!last) throw new Error('no body to type into')
  doc.transact(() => last.insert(last.length, text), origin)
}

// oxlint-disable-next-line typescript/no-base-to-string -- Y.XmlFragment toString returns the document text
const bodyOf = (doc: Y.Doc): string => doc.getXmlFragment(CRDT_FRAGMENT_NAME).toString()
const rootsOf = (doc: Y.Doc): number => doc.getXmlFragment(CRDT_FRAGMENT_NAME).length

/** The store's copy of a note, read through a fresh handle once the session closed it. */
async function storedNote(noteId: string): Promise<Y.Doc> {
  const store = new LeveldbPersistence(h.storeDir)
  try {
    const stored = await store.getYDoc(noteId)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(stored))
    return doc
  } finally {
    await store.destroy()
  }
}

/** What an earlier session left in the store. */
async function storeBefore(noteId: string, doc: Y.Doc): Promise<void> {
  const store = new LeveldbPersistence(h.storeDir)
  await store.storeUpdate(noteId, Y.encodeStateAsUpdate(doc))
  await store.destroy()
}

const outbox = { enqueue: vi.fn(), enqueueFullState: vi.fn(), dropNote: vi.fn() }

/** A provider whose open timed out on the probe: in memory, waiting for the store. */
async function inMemoryProvider(): Promise<CrdtProvider> {
  const provider = new CrdtProvider()
  const init = provider.init(outbox as never)
  await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
  await init
  expect(provider.hasPersistence()).toBe(false)
  return provider
}

/** The probe's delayed round trip runs, and the session switches once it answers. */
async function storeAnswers(provider: CrdtProvider): Promise<void> {
  await vi.advanceTimersByTimeAsync(PROBE_DELAY_MS - PROBE_TIMEOUT_MS)
  await vi.waitFor(() => expect(provider.hasPersistence()).toBe(true), { timeout: 5_000 })
}

const switchLogs = (): typeof h.logs =>
  h.logs.filter((entry) => entry.message === 'CRDT store opened late; the session now persists')
const noteCalls = (noteId: string): string[] =>
  h.calls.filter((call) => call.endsWith(`:${noteId}`)).map((call) => call.split(':')[0])

describe('a store whose probe timed out at open', () => {
  let provider: CrdtProvider | null = null

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.stubEnv('MEMRY_TEST_CRDT_PROBE_DELAY_MS', String(PROBE_DELAY_MS))
    h.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-late-store-'))
    h.preflight = { ok: true }
    h.calls = []
    h.handles = []
    h.hold = null
    h.logs = []
    h.broadcasts = []
    h.sent = []
    h.outcomes = []
    outbox.enqueue.mockClear()
    _resetCrdtSessionOutcomeForTests()
  })

  afterEach(async () => {
    await provider?.destroy()
    provider = null
    vi.useRealTimers()
    vi.unstubAllEnvs()
    fs.rmSync(h.storeDir, { recursive: true, force: true })
  })

  it('switches the session to the store once the probe answers', async () => {
    provider = await inMemoryProvider()
    expect(provider.storeId).toBeNull()
    expect(h.outcomes).toEqual([false])

    await storeAnswers(provider)

    expect(provider.storeId).not.toBeNull()
    expect(await provider.isPersistent()).toBe(true)
    // One handle, the timed-out probe's own: no second open raced it for the lock.
    expect(h.calls.filter((call) => call === 'open')).toHaveLength(1)
    const [logged] = switchLogs()
    expect((logged.meta as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(PROBE_DELAY_MS)
    // The streak of in-memory launches ends: this launch has a store.
    expect(h.outcomes).toEqual([false, true])
  })

  it('writes each live doc, applies the stored state, then attaches the store', async () => {
    // An earlier session stored the note's body and an edit this session never saw.
    const earlier = new Y.Doc()
    writeBody(earlier, 'Shared body.')
    const base = Y.encodeStateAsUpdate(earlier)
    type(earlier, ' Stored edit.', 'local')
    await storeBefore(NOTE, earlier)

    provider = await inMemoryProvider()
    const doc = await provider.open(NOTE, EDITOR, { skipSeed: true })
    // The pull merged the server's copy of the body, then the user typed.
    provider.applyRemoteUpdate(NOTE, base)
    type(doc, ' Typed in memory.')
    const persistedAtApply: boolean[] = []
    doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin === 'late-store') persistedAtApply.push(provider!.hasPersistence())
    })
    outbox.enqueue.mockClear()
    h.sent = []

    await storeAnswers(provider)

    // 1. whole state written, 2. stored state read and applied while nothing
    // is attached, 3. attached, storing what the doc took since its write.
    expect(noteCalls(NOTE)).toEqual(['read', 'store', 'read', 'store'])
    expect(persistedAtApply).toEqual([false])
    // Two concurrent appends: Yjs orders them by client, the same on every device.
    for (const part of ['Shared body.', ' Stored edit.', ' Typed in memory.']) {
      expect(bodyOf(doc).split(part)).toHaveLength(2)
    }
    expect(rootsOf(doc)).toBe(1)
    // The editor got the stored edit; the server is not owed it again.
    expect(h.sent.some(({ payload }) => payload.noteId === NOTE)).toBe(true)
    expect(outbox.enqueue).not.toHaveBeenCalled()
  })

  it('keeps the edits made before and after the switch', async () => {
    provider = await inMemoryProvider()
    const doc = await provider.open(NOTE, EDITOR, { skipSeed: true })
    writeBody(doc, 'Body.', ipc)
    type(doc, ' Before.')

    await storeAnswers(provider)
    type(doc, ' After.')
    await provider.whenPersisted(NOTE)
    await provider.destroy()
    provider = null

    const stored = await storedNote(NOTE)
    expect(bodyOf(stored)).toContain('Body. Before. After.')
    expect(rootsOf(stored)).toBe(1)
  })

  it('replaces a stored copy the in-memory doc shares no history with', async () => {
    const earlier = new Y.Doc()
    writeBody(earlier, 'Same text.')
    await storeBefore(NOTE, earlier)

    provider = await inMemoryProvider()
    const doc = await provider.open(NOTE, EDITOR, { skipSeed: true })
    // Seeded from the vault file this session: the same text, other Yjs items.
    writeBody(doc, 'Same text.')
    type(doc, ' Typed.')

    await storeAnswers(provider)

    expect(rootsOf(doc)).toBe(1)
    expect(bodyOf(doc)).toContain('Same text. Typed.')
    expect((switchLogs()[0].meta as { replacedNoteIds: string[] }).replacedNoteIds).toEqual([NOTE])
    await provider.destroy()
    provider = null
    const stored = await storedNote(NOTE)
    expect(rootsOf(stored)).toBe(1)
    expect(bodyOf(stored)).toContain('Same text. Typed.')
    expect(Y.decodeStateVector(Y.encodeStateVector(stored)).has(earlier.clientID)).toBe(false)
  })

  it('stores a doc closed before the switch, and the next open reads it from the store', async () => {
    provider = await inMemoryProvider()
    const doc = await provider.open(NOTE, EDITOR, { skipSeed: true })
    writeBody(doc, 'Closed body.', ipc)
    await provider.close(NOTE, EDITOR)
    expect(provider.getDoc(NOTE)).toBeUndefined()

    await storeAnswers(provider)

    const reopened = await provider.open(NOTE, EDITOR, { skipSeed: true })
    expect(bodyOf(reopened)).toContain('Closed body.')
    expect(rootsOf(reopened)).toBe(1)
  })

  it('clears a note purged before the switch from the store', async () => {
    const earlier = new Y.Doc()
    writeBody(earlier, 'Deleted note.')
    await storeBefore(NOTE, earlier)

    provider = await inMemoryProvider()
    await provider.purge(NOTE)
    await storeAnswers(provider)
    await provider.destroy()
    provider = null

    expect(Y.encodeStateVector(await storedNote(NOTE))).toEqual(Y.encodeStateVector(new Y.Doc()))
  })

  it('hands an editor that waits for its server body the stored body', async () => {
    const earlier = new Y.Doc()
    writeBody(earlier, 'Stored body.')
    await storeBefore(NOTE, earlier)

    provider = await inMemoryProvider()
    // No merge wired and sync undecided: the doc opens empty and waits (#5290).
    const doc = await provider.openForEditor(NOTE, EDITOR, null)
    expect(provider.isAwaitingMerge(NOTE)).toBe(true)

    await storeAnswers(provider)

    expect(provider.isAwaitingMerge(NOTE)).toBe(false)
    expect(bodyOf(doc)).toContain('Stored body.')
    expect(h.broadcasts).toContainEqual({
      channel: CRDT_EVENTS.DOC_LOADED,
      payload: { noteId: NOTE }
    })
  })

  it('never retries a failed preflight', async () => {
    h.preflight = { ok: false, stage: 'binding', reason: 'binding failed to load' }
    provider = await inMemoryProvider()

    await vi.advanceTimersByTimeAsync(15 * 60_000)

    expect(h.calls).toEqual([])
    expect(provider.hasPersistence()).toBe(false)
    expect(switchLogs()).toEqual([])
  })

  it('retries a probe that failed in-band, only once its handle closed', async () => {
    // Another handle holds the directory's lock, so the late round trip fails.
    const holder = new LeveldbPersistence(h.storeDir)
    await holder.getYDoc('held')

    provider = await inMemoryProvider()
    await vi.advanceTimersByTimeAsync(PROBE_DELAY_MS - PROBE_TIMEOUT_MS)
    await vi.waitFor(() => expect(h.calls).toContain('destroy'), { timeout: 5_000 })
    expect(provider.hasPersistence()).toBe(false)
    await holder.destroy()

    // The retry waits out its backoff, then opens a fresh handle.
    await vi.advanceTimersByTimeAsync(15_000 + PROBE_DELAY_MS)
    await vi.waitFor(() => expect(provider!.hasPersistence()).toBe(true), { timeout: 5_000 })
    const lifecycle = h.calls.filter((call) => call === 'open' || call === 'destroy')
    expect(lifecycle).toEqual(['open', 'destroy', 'open'])
  })

  it('a vault close cancels the wait and leaves the directory unlocked', async () => {
    provider = await inMemoryProvider()

    await provider.destroy()
    provider = null
    await vi.advanceTimersByTimeAsync(PROBE_DELAY_MS)

    expect(h.handles).toHaveLength(1)
    expect(h.handles[0].destroyed).toBe(true)
    expect(switchLogs()).toEqual([])
    // The vault opens again and gets its store at once.
    vi.stubEnv('MEMRY_TEST_CRDT_PROBE_DELAY_MS', '0')
    provider = new CrdtProvider()
    await provider.initPersistence()
    expect(provider.hasPersistence()).toBe(true)
  })

  it('a vault close during the switch attaches nothing and closes the store', async () => {
    provider = await inMemoryProvider()
    const doc = await provider.open(NOTE, EDITOR, { skipSeed: true })
    writeBody(doc, 'Body.', ipc)
    const reached = new Promise<void>((resolve) => {
      h.hold = { noteId: NOTE, release: () => {}, reached: resolve }
    })
    const hold = h.hold!

    await vi.advanceTimersByTimeAsync(PROBE_DELAY_MS - PROBE_TIMEOUT_MS)
    await reached
    const closing = provider.destroy()
    hold.release()
    await closing
    const closed = provider
    provider = null

    expect(closed.hasPersistence()).toBe(false)
    expect(h.handles[0].destroyed).toBe(true)
    expect(switchLogs()).toEqual([])
  })
})
