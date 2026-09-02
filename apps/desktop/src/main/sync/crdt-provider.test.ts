import * as Y from 'yjs'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CrdtPreflightStage } from '@memry/sync-client/crdt-preflight-protocol'

type PreflightVerdict = {
  ok: boolean
  reason?: string
  stage?: CrdtPreflightStage
  /** Side effect the real child would have had on disk before dying. */
  onCall?: () => void
}

// Lets a single test make `renameSync` fail the way Windows does (EPERM on a
// locked store dir) without disturbing the real fs everything else here uses.
const fsHooks = vi.hoisted(() => ({
  renameSync: null as null | ((from: string, to: string) => void),
  cpSync: null as null | ((from: string, to: string) => void),
  realRenameSync: (from: string, to: string): void => {
    throw new Error(`fs mock not installed (${from} -> ${to})`)
  }
}))

vi.mock('fs', async (importActual) => {
  const actual = await importActual<typeof import('fs')>()
  fsHooks.realRenameSync = actual.renameSync
  const renameSync = (from: string, to: string): void =>
    (fsHooks.renameSync ?? actual.renameSync)(from, to)
  const cpSync = (from: string, to: string, options?: Parameters<typeof actual.cpSync>[2]): void =>
    fsHooks.cpSync ? fsHooks.cpSync(from, to) : actual.cpSync(from, to, options)
  return { ...actual, default: { ...actual, renameSync, cpSync }, renameSync, cpSync }
})

/** Makes every way of moving a directory fail, the way a full disk or AV does. */
const failEveryMove = (): void => {
  const fail = (): never => {
    const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException
    err.code = 'EPERM'
    throw err
  }
  fsHooks.renameSync = fail
  fsHooks.cpSync = fail
}

const mocks = vi.hoisted(() => {
  // Simulates a broken classic-level native binding (napi_create_reference
  // failures on ABI mismatch). 'reject' fails ops; 'hang' never settles.
  const persistenceBehavior = { mode: 'ok' as 'ok' | 'reject' | 'hang' }
  const persistenceOpFactory = async <T>(value: () => T): Promise<T> => {
    if (persistenceBehavior.mode === 'reject') {
      throw new Error('napi_create_reference(env, callback, 1, &callbackRef_) failed!')
    }
    if (persistenceBehavior.mode === 'hang') {
      return new Promise<T>(() => {})
    }
    return value()
  }
  return {
    persistenceBehavior,
    persistenceOpFactory,
    // Per-run temp dir, assigned once the real fs is importable (below). A
    // fixed name in a world-writable dir is a symlink-swap target.
    userDataDir: '',
    // The open vault's identity — what the CRDT store is scoped to. null for
    // `dataDb` means no vault is open, which must defer the store init.
    dataDb: {} as object | null,
    vaultUuid: '11111111-2222-3333-4444-555555555555',
    legacyStoreClaim: undefined as string | undefined,
    /** Persisted streak the degraded-persistence notice is thresholded on. */
    recordPersistenceOutcome: vi.fn((..._args: unknown[]) => 0),
    // Verdict of the disposable utilityProcess preflight (see crdt-preflight.ts).
    // preflightQueue serves per-call verdicts (quarantine retry = second call);
    // when empty, preflightResult is the standing answer.
    preflightResult: { ok: true } as PreflightVerdict,
    preflightQueue: [] as PreflightVerdict[],
    preflightCalls: [] as string[],
    sent: [] as Array<{ windowId: number; channel: string; payload: unknown }>,
    windows: new Map<
      number,
      { isDestroyed: ReturnType<typeof vi.fn>; webContents: { send: ReturnType<typeof vi.fn> } }
    >(),
    getNoteCacheById: vi.fn(),
    updateNoteCache: vi.fn(),
    updateNoteMetadata: vi.fn(),
    enqueueLocalSyncUpdate: vi.fn(),
    removePendingNoteSyncItems: vi.fn(),
    /** Overridden by the one test that needs a path a real `stat` can reach. */
    toAbsolutePath: vi.fn((path: string) => `/vault/${path}`),
    safeRead: vi.fn(),
    parseNote: vi.fn(),
    markdownToYFragment: vi.fn(),
    repairEmptyBlockIds: vi.fn((..._args: unknown[]) => 0),
    compactYDoc: vi.fn(),
    scheduleWriteback: vi.fn(),
    flushPendingWritebacks: vi.fn(),
    recordNetworkUpdate: vi.fn(),
    resetWritebackState: vi.fn(),
    persistenceInstances: [] as Array<{
      getYDoc: ReturnType<typeof vi.fn>
      clearDocument: ReturnType<typeof vi.fn>
      destroy: ReturnType<typeof vi.fn>
      storeUpdate: ReturnType<typeof vi.fn>
      flushDocument: ReturnType<typeof vi.fn>
    }>
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userDataDir },
  BrowserWindow: {
    fromId: (id: number) => mocks.windows.get(id) ?? null,
    getAllWindows: () => Array.from(mocks.windows.values())
  }
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('./crdt-preflight', () => ({
  runCrdtPreflight: vi.fn(async (storeDir: string) => {
    mocks.preflightCalls.push(storeDir)
    const queued = mocks.preflightQueue.shift()
    const { onCall, ...verdict } = queued ?? mocks.preflightResult
    onCall?.()
    return verdict
  })
}))

vi.mock('y-leveldb', () => ({
  LeveldbPersistence: class {
    getYDoc = vi.fn((noteId: string) =>
      mocks.persistenceOpFactory(() => new Y.Doc({ guid: `${noteId}:persisted` }))
    )
    clearDocument = vi.fn(() => mocks.persistenceOpFactory(() => undefined))
    destroy = vi.fn(async () => {})
    storeUpdate = vi.fn(() => mocks.persistenceOpFactory(() => undefined))
    flushDocument = vi.fn(() => mocks.persistenceOpFactory(() => undefined))

    constructor() {
      mocks.persistenceInstances.push(this)
    }
  }
}))

vi.mock('../database/client', () => ({
  getIndexDatabase: () => ({ kind: 'index-db' }),
  getDatabase: () => mocks.dataDb,
  isDatabaseInitialized: () => mocks.dataDb !== null
}))

vi.mock('../agent/storage/vault-id', () => ({
  getOrCreateVaultUuid: () => mocks.vaultUuid
}))

vi.mock('../store', () => ({
  getLegacyCrdtStoreClaim: () => mocks.legacyStoreClaim,
  recordLegacyCrdtStoreClaim: (vaultUuid: string) => {
    mocks.legacyStoreClaim = vaultUuid
  },
  getVaults: () => [],
  getLegacyCrdtStorePartitionPending: () => undefined,
  clearLegacyCrdtStorePartitionPending: vi.fn(),
  getPendingCrdtStoreRename: () => undefined,
  clearPendingCrdtStoreRename: vi.fn(),
  getCrdtInMemorySessions: () => 0,
  recordCrdtPersistenceOutcome: (...args: unknown[]) => mocks.recordPersistenceOutcome(...args)
}))

vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: (...args: unknown[]) => mocks.getNoteCacheById(...args),
  updateNoteCache: (...args: unknown[]) => mocks.updateNoteCache(...args)
}))

// Everything below stands up `setNoteLocalOnlyState` — the real toggle — so the
// local-only suite can drive the whole chain rather than two mocks of each
// other. Only the two databases and the record feed are faked; the provider and
// the durable pending store on the other side of the seam are real. None of
// these modules is reachable from crdt-provider.ts, so they are inert for every
// other test in this file.
vi.mock('../database', () => ({
  getDatabase: () => mocks.dataDb,
  getIndexDatabase: () => ({ kind: 'index-db' })
}))
vi.mock('@memry/storage-data', () => ({
  updateNoteMetadata: (...args: unknown[]) => mocks.updateNoteMetadata(...args)
}))
vi.mock('./local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  enqueueLocalSyncUpdate: (...args: unknown[]) => mocks.enqueueLocalSyncUpdate(...args),
  removePendingNoteSyncItems: (...args: unknown[]) => mocks.removePendingNoteSyncItems(...args)
}))
vi.mock('@memry/sync-client/attachment-events', () => ({
  attachmentEvents: { emitSaved: vi.fn() }
}))
vi.mock('../tasks/domain', () => ({ createDesktopTasksDomain: vi.fn() }))
vi.mock('../tasks/publisher', () => ({ createTasksPublisher: vi.fn() }))
vi.mock('../lib/id', () => ({ generateId: vi.fn(() => 'generated-id') }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn() }))

vi.mock('../vault/notes', () => ({
  toAbsolutePath: (path: string) => mocks.toAbsolutePath(path)
}))

vi.mock('../vault/file-ops', () => ({
  safeRead: (...args: unknown[]) => mocks.safeRead(...args)
}))

vi.mock('../vault/frontmatter', () => ({
  parseNote: (...args: unknown[]) => mocks.parseNote(...args),
  serializeNote: vi.fn(),
  serializeParsedNote: vi.fn(),
  generateContentHash: (content: unknown) => `hash:${String(content)}`
}))

vi.mock('./blocknote-converter', () => ({
  markdownToYFragment: (...args: unknown[]) => mocks.markdownToYFragment(...args),
  repairEmptyBlockIds: (...args: unknown[]) => mocks.repairEmptyBlockIds(...args)
}))

vi.mock('@memry/sync-client/crdt-compact-utils', () => ({
  compactYDoc: (...args: unknown[]) => mocks.compactYDoc(...args)
}))

vi.mock('./crdt-writeback', () => ({
  scheduleWriteback: (...args: unknown[]) => mocks.scheduleWriteback(...args),
  flushPendingWritebacks: (...args: unknown[]) => mocks.flushPendingWritebacks(...args),
  recordNetworkUpdate: (...args: unknown[]) => mocks.recordNetworkUpdate(...args),
  resetWritebackState: (...args: unknown[]) => mocks.resetWritebackState(...args)
}))

vi.mock('@memry/sync-client/microtask-batch-broadcaster', () => ({
  MicrotaskBatchBroadcaster: class {
    private queued = new Map<string, Uint8Array>()

    constructor(private readonly onFlush: (noteId: string, update: Uint8Array) => void) {}

    enqueue(noteId: string, update: Uint8Array): void {
      this.queued.set(noteId, update)
    }

    flush(noteId: string): void {
      const update = this.queued.get(noteId)
      if (!update) return
      this.queued.delete(noteId)
      this.onFlush(noteId, update)
    }

    flushAll(): void {
      for (const noteId of Array.from(this.queued.keys())) {
        this.flush(noteId)
      }
    }
  }
}))

import { CRDT_EVENTS, CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { NOTE_MAX_BYTES } from '@memry/shared/markdown-class'
import { CrdtProvider, getCrdtProvider, resetCrdtProvider } from './crdt-provider'
import type { SnapshotPushFn } from './crdt-provider'
// Deliberately NOT mocked: the point of the signed-out suite below is that the
// recorder and the replay meet on the same durable store, so both halves run
// for real against the temp userData dir.
import { drainPendingCrdtNotes, readPendingCrdtNotes } from './crdt-pending-notes'
// The real toggle, so the local-only suite crosses the seam for real.
import { setNoteLocalOnlyState } from '../notes/runtime-effects'

mocks.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-crdt-'))

const VAULT_UUID = mocks.vaultUuid
/** Where the store lands now that it is scoped to the open vault. */
const vaultStoreDir = (uuid: string = VAULT_UUID): string =>
  `${mocks.userDataDir}/crdt-stores/${uuid}`

const createWindow = (id: number, destroyed = false) => {
  const win = {
    isDestroyed: vi.fn(() => destroyed),
    webContents: {
      send: vi.fn((channel: string, payload: unknown) => {
        mocks.sent.push({ windowId: id, channel, payload })
      })
    }
  }
  mocks.windows.set(id, win)
  return win
}

const makeRemoteUpdate = (text: string): Uint8Array => {
  const doc = new Y.Doc()
  doc.getMap('meta').set('title', text)
  return Y.encodeStateAsUpdate(doc)
}

describe('CrdtProvider', () => {
  let provider: CrdtProvider
  let queue: { enqueue: ReturnType<typeof vi.fn>; dropNote: ReturnType<typeof vi.fn> }
  let pushSnapshot: ReturnType<typeof vi.fn<SnapshotPushFn>>

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.sent = []
    mocks.windows.clear()
    mocks.persistenceInstances.length = 0
    mocks.persistenceBehavior.mode = 'ok'
    mocks.preflightResult = { ok: true }
    mocks.preflightQueue.length = 0
    mocks.preflightCalls.length = 0
    mocks.dataDb = {}
    mocks.vaultUuid = VAULT_UUID
    mocks.legacyStoreClaim = undefined
    mocks.getNoteCacheById.mockReturnValue({
      id: 'note-1',
      path: 'notes/Note.md',
      title: 'Note',
      fileType: 'markdown'
    })
    mocks.toAbsolutePath.mockImplementation((path: string) => `/vault/${path}`)
    mocks.safeRead.mockResolvedValue('# Note\n\nBody')
    mocks.parseNote.mockReturnValue({ content: 'Body' })
    mocks.markdownToYFragment.mockImplementation(
      async (_content: string, fragment: Y.XmlFragment) => {
        fragment.insert(0, [new Y.XmlText('Body')])
        return true
      }
    )
    mocks.compactYDoc.mockReturnValue(null)
    queue = { enqueue: vi.fn(), dropNote: vi.fn() }
    pushSnapshot = vi.fn<SnapshotPushFn>().mockResolvedValue(undefined)
    provider = new CrdtProvider()
    await provider.init(queue as any, pushSnapshot)
  })

  afterEach(() => {
    resetCrdtProvider()
  })

  it('initializes persistence, seeds markdown, exposes metadata, and closes cleanly', async () => {
    const doc = await provider.initForNote('note-1', { title: 'Seeded', date: '2026-01-01' }, [
      'tag-a'
    ])

    expect(provider.isInitialized()).toBe(true)
    expect(doc.getMap('meta').get('title')).toBe('Seeded')
    expect(doc.getMap('meta').get('date')).toBe('2026-01-01')
    expect(doc.getArray('tags').toArray()).toEqual(['tag-a'])
    expect(mocks.safeRead).toHaveBeenCalledWith('/vault/notes/Note.md')
    expect(mocks.markdownToYFragment).toHaveBeenCalled()
    expect(mocks.persistenceInstances[0].storeUpdate).toHaveBeenCalled()

    provider.updateMeta('note-1', { title: 'Updated' })
    expect(doc.getMap('meta').get('title')).toBe('Updated')

    await provider.close('note-1')
    expect(mocks.persistenceInstances[0].flushDocument).toHaveBeenCalledWith('note-1')
    expect(provider.getDoc('note-1')).toBeUndefined()
  })

  it('broadcasts IPC updates to other windows, persists, queues local sync, and schedules writeback', async () => {
    createWindow(1)
    createWindow(2)
    await provider.open('note-1', 1, { skipSeed: true })
    await provider.open('note-1', 2, { skipSeed: true })

    provider.applyIpcUpdate('note-1', makeRemoteUpdate('from renderer'), 1)

    expect(mocks.sent).toHaveLength(1)
    expect(mocks.sent[0]).toMatchObject({
      windowId: 2,
      channel: CRDT_EVENTS.STATE_CHANGED,
      payload: {
        noteId: 'note-1',
        origin: 'ipc'
      }
    })
    expect(queue.enqueue).toHaveBeenCalled()
    expect(mocks.persistenceInstances[0].storeUpdate).toHaveBeenCalled()
    expect(mocks.scheduleWriteback).toHaveBeenCalledWith('note-1', expect.any(Y.Doc))
  })

  it('persists and writes back an edit made with no session, and pushes nothing', async () => {
    // Why the signed-out queue needs no pause: teardown drops it. The editor is
    // no longer gated on a session, so this is now the steady state — every
    // keystroke made signed out reaches the local store and the vault markdown,
    // and nothing reaches the 1s flush loop, so nothing retries a push or reads
    // the keychain for a token that is not there. Sign-out goes further still
    // (resetCrdtProvider builds a fresh instance), which makes this the weaker
    // of the two guarantees and therefore the one worth pinning.
    createWindow(1)
    await provider.destroy()
    await provider.initPersistence()
    await provider.open('note-1', 1, { skipSeed: true })
    queue.enqueue.mockClear()

    provider.applyIpcUpdate('note-1', makeRemoteUpdate('typed while signed out'), 1)

    expect(queue.enqueue).not.toHaveBeenCalled()
    expect(mocks.persistenceInstances.at(-1)!.storeUpdate).toHaveBeenCalled()
    expect(mocks.scheduleWriteback).toHaveBeenCalledWith('note-1', expect.any(Y.Doc))
  })

  it('broadcasts one shared Uint8Array instead of a boxed copy per receiving window', async () => {
    createWindow(1)
    createWindow(2)
    createWindow(3)
    await provider.open('note-1', 1, { skipSeed: true })
    await provider.open('note-1', 2, { skipSeed: true })
    await provider.open('note-1', 3, { skipSeed: true })

    const update = makeRemoteUpdate('typed payload')
    provider.applyIpcUpdate('note-1', update, 1)

    // Two receivers (the source window is skipped).
    expect(mocks.sent).toHaveLength(2)
    const payloads = mocks.sent.map((entry) => entry.payload as { update: unknown })
    for (const payload of payloads) {
      expect(payload.update).toBeInstanceOf(Uint8Array)
    }
    // One allocation for the whole fan-out — not Array.from() inside the loop.
    expect(payloads[0].update).toBe(payloads[1].update)
  })

  it('buffers network broadcasts until close and records network-origin writeback', async () => {
    createWindow(7)
    await provider.open('note-1', 7, { skipSeed: true })

    provider.applyRemoteUpdate('note-1', new Uint8Array(makeRemoteUpdate('remote')))
    expect(mocks.sent).toEqual([])
    expect(queue.enqueue).not.toHaveBeenCalled()
    expect(mocks.recordNetworkUpdate).toHaveBeenCalledWith('note-1')
    expect(mocks.scheduleWriteback).toHaveBeenCalledWith('note-1', expect.any(Y.Doc))

    await provider.close('note-1')
    expect(mocks.sent[0]).toMatchObject({
      windowId: 7,
      channel: CRDT_EVENTS.STATE_CHANGED,
      payload: {
        noteId: 'note-1',
        origin: 'network'
      }
    })
  })

  it('pushes snapshots for markdown notes and skips binary or empty docs', async () => {
    await provider.initForNote('note-1', { title: 'Snapshot' }, ['tag-a'])
    expect(await provider.pushSnapshotForNote('note-1')).toBe(true)
    expect(pushSnapshot).toHaveBeenCalledWith('note-1', expect.any(Uint8Array))

    mocks.getNoteCacheById.mockReturnValueOnce({
      id: 'pdf-note',
      path: 'notes/File.pdf',
      fileType: 'pdf'
    })
    expect(await provider.pushSnapshotForNote('pdf-note')).toBe(false)

    mocks.getNoteCacheById.mockReturnValue({
      id: 'empty-note',
      path: 'notes/Empty.md',
      fileType: 'markdown'
    })
    mocks.safeRead.mockResolvedValueOnce('')
    expect(await provider.pushSnapshotForNote('empty-note')).toBe(false)
  })

  it('keeps the pending snapshot for retry when the snapshot push fails', async () => {
    await provider.initForNote('note-1', { title: 'Snapshot' }, [])
    provider.updateMeta('note-1', { title: 'Edited before push' })

    pushSnapshot.mockRejectedValueOnce(new Error('401 exp claim'))
    expect(await provider.pushSnapshotForNote('note-1')).toBe(false)

    pushSnapshot.mockClear()
    pushSnapshot.mockResolvedValue(undefined)
    await expect(provider.pushAllSnapshots()).resolves.toBe(1)
    expect(pushSnapshot).toHaveBeenCalledWith('note-1', expect.any(Uint8Array))
  })

  it('seeds existing docs in batches, validates CRDT eligibility, purges, and destroys storage', async () => {
    const progress = vi.fn()
    const seeded = await provider.seedExistingDocs(
      [
        { id: 'seed-a', title: 'A', tags: ['a'] },
        { id: 'seed-b', title: 'B', date: '2026-01-02' }
      ],
      progress
    )

    expect(seeded).toBe(2)
    expect(progress).toHaveBeenCalledWith(2, 2)
    expect(provider.validateNoteForCrdt('seed-a')).toEqual({ ok: true })

    mocks.getNoteCacheById.mockReturnValueOnce(null)
    expect(provider.validateNoteForCrdt('missing')).toEqual({
      ok: false,
      error: 'Note not found: missing'
    })

    mocks.getNoteCacheById.mockReturnValueOnce({ id: 'bin', fileType: 'image' })
    expect(provider.validateNoteForCrdt('bin')).toEqual({
      ok: false,
      error: 'Binary notes do not use CRDT: bin'
    })

    await provider.purge('seed-a')
    expect(mocks.persistenceInstances[0].clearDocument).toHaveBeenCalledWith('seed-a')

    await provider.destroy()
    expect(mocks.flushPendingWritebacks).toHaveBeenCalled()
    expect(mocks.persistenceInstances[0].destroy).toHaveBeenCalled()
    // Vault close / vault switch runs through here, so the write-back module's
    // per-note maps must not carry this vault's ids into the next one.
    expect(mocks.resetWritebackState).toHaveBeenCalled()
  })

  it('returns state vectors and diffs only for open docs', async () => {
    expect(provider.getStateVector('closed')).toBeNull()
    expect(provider.getDiff('closed', new Uint8Array())).toBeNull()

    const doc = await provider.open('note-1', undefined, { skipSeed: true })
    doc.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [new Y.XmlText('hello')])

    const stateVector = provider.getStateVector('note-1')
    expect(stateVector).toBeInstanceOf(Uint8Array)
    expect(provider.getDiff('note-1', Y.encodeStateVector(new Y.Doc()))).toBeInstanceOf(Uint8Array)
    expect(provider.getOpenNoteIds()).toEqual(['note-1'])
    expect(provider.getDocSizeMetrics()[0]).toEqual(
      expect.objectContaining({ noteId: 'note-1', windowCount: 0 })
    )
  })

  it('separates docs with a live editor from the ones the cache merely retains', async () => {
    // getOpenNoteIds() is every doc in the LRU cache, including the up-to-32 an
    // editor has already released. Reconnect recovery needs the smaller set.
    createWindow(1)
    await provider.open('with-editor', 1, { skipSeed: true })
    await provider.open('cached-only', undefined, { skipSeed: true })

    expect(provider.getOpenNoteIds().sort()).toEqual(['cached-only', 'with-editor'])
    expect(provider.getOpenNoteIds({ active: true })).toEqual(['with-editor'])

    await provider.close('with-editor', 1)

    expect(provider.getOpenNoteIds({ active: true })).toEqual([])
  })

  it('exposes aggregate open-doc metrics with per-doc size and window counts', async () => {
    createWindow(1)
    await provider.open('note-1', 1, { skipSeed: true })
    await provider.open('sync-only-note', undefined, { skipSeed: true })

    provider.updateMeta('note-1', { title: 'Active editor' })
    provider.updateMeta('sync-only-note', { title: 'Sync only' })

    const metrics = provider.getOpenDocMetrics()

    expect(metrics.count).toBe(2)
    expect(metrics.totalEncodedSizeBytes).toBeGreaterThan(0)
    expect(metrics.docs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          noteId: 'note-1',
          encodedSizeBytes: expect.any(Number),
          windowCount: 1
        }),
        expect.objectContaining({
          noteId: 'sync-only-note',
          encodedSizeBytes: expect.any(Number),
          windowCount: 0
        })
      ])
    )
  })

  it('keeps shared docs open until the last window closes', async () => {
    createWindow(1)
    createWindow(2)

    const doc = await provider.open('note-1', 1, { skipSeed: true })
    await provider.open('note-1', 2, { skipSeed: true })

    await provider.close('note-1', 1)
    expect(provider.getDoc('note-1')).toBe(doc)
    expect(mocks.persistenceInstances[0].flushDocument).not.toHaveBeenCalledWith('note-1')

    await provider.close('note-1', 2)
    expect(provider.getDoc('note-1')).toBeUndefined()
    expect(mocks.persistenceInstances[0].flushDocument).toHaveBeenCalledWith('note-1')
  })

  it('closes sync-only docs only while they remain inactive', async () => {
    await provider.open('sync-only-note', undefined, { skipSeed: true })

    await expect(provider.closeIfInactive('sync-only-note')).resolves.toBe(true)
    expect(provider.getDoc('sync-only-note')).toBeUndefined()
    expect(mocks.persistenceInstances[0].flushDocument).toHaveBeenCalledWith('sync-only-note')

    createWindow(8)
    const activeDoc = await provider.open('active-note', 8, { skipSeed: true })

    await expect(provider.closeIfInactive('active-note')).resolves.toBe(false)
    expect(provider.getDoc('active-note')).toBe(activeDoc)
  })

  it('releases the docs of a destroyed window and closes the ones it was last to hold', async () => {
    // A window torn down by ⌘W / reload / renderer crash never runs the React
    // cleanup that sends crdt:close-doc, and BrowserWindow ids are never
    // recycled — so without an explicit release the stale id pins the doc for
    // the rest of the session and disables eviction and compaction with it.
    createWindow(11)
    createWindow(12)

    const shared = await provider.open('shared-note', 11, { skipSeed: true })
    await provider.open('shared-note', 12, { skipSeed: true })
    await provider.open('solo-note', 11, { skipSeed: true })

    await provider.forgetWindow(11)

    // Window 12 is still live and editing shared-note — never evict under it.
    expect(provider.getDoc('shared-note')).toBe(shared)
    expect(
      provider.getOpenDocMetrics().docs.find((doc) => doc.noteId === 'shared-note')?.windowCount
    ).toBe(1)

    // solo-note lost its only window: flushed to persistence, then released.
    expect(mocks.persistenceInstances[0].flushDocument).toHaveBeenCalledWith('solo-note')
    expect(provider.getDoc('solo-note')).toBeUndefined()
  })

  it('drops broadcast targets whose window is gone so the doc stops being pinned', async () => {
    createWindow(21)
    await provider.open('note-1', 21, { skipSeed: true })
    expect(provider.getOpenDocMetrics().docs[0].windowCount).toBe(1)

    // The window is destroyed without any close-doc IPC and without the
    // 'closed' hook having run (e.g. it was opened before registration).
    mocks.windows.delete(21)

    provider.updateMeta('note-1', { title: 'still typing' })

    expect(provider.getOpenDocMetrics().docs[0].windowCount).toBe(0)
    await expect(provider.closeIfInactive('note-1')).resolves.toBe(true)
  })

  it('evicts least-recently-used inactive docs without evicting active editor docs', async () => {
    let now = 1_000
    const cappedProvider = new CrdtProvider({
      inactiveDocLimit: 2,
      now: () => now
    })
    await cappedProvider.init(queue as any, pushSnapshot)
    createWindow(9)

    await cappedProvider.open('active-note', 9, { skipSeed: true })
    now += 1
    await cappedProvider.open('inactive-a', undefined, { skipSeed: true })
    now += 1
    await cappedProvider.open('inactive-b', undefined, { skipSeed: true })
    now += 1
    await cappedProvider.open('inactive-c', undefined, { skipSeed: true })

    expect(cappedProvider.getDoc('active-note')).toBeDefined()
    expect(cappedProvider.getDoc('inactive-a')).toBeUndefined()
    expect(cappedProvider.getDoc('inactive-b')).toBeDefined()
    expect(cappedProvider.getDoc('inactive-c')).toBeDefined()

    const cappedMetrics = cappedProvider.getOpenDocMetrics()
    expect(cappedMetrics.count).toBe(3)
    expect(cappedMetrics.docs.filter((doc) => doc.windowCount === 0)).toHaveLength(2)

    await cappedProvider.destroy()
  })

  it('pushes only pending snapshots and resets pending byte counters', async () => {
    await provider.open('note-1', undefined, { skipSeed: true })
    provider.updateMeta('note-1', { title: 'Pending snapshot' })

    await expect(provider.pushAllSnapshots()).resolves.toBe(1)
    expect(pushSnapshot).toHaveBeenCalledWith('note-1', expect.any(Uint8Array))

    pushSnapshot.mockClear()
    await expect(provider.pushAllSnapshots()).resolves.toBe(0)
    expect(pushSnapshot).not.toHaveBeenCalled()
  })

  it('applies IPC sync step 2 diffs without echoing back to renderer window -1', async () => {
    createWindow(3)
    await provider.open('note-1', 3, { skipSeed: true })

    provider.applyIpcSyncStep2('note-1', makeRemoteUpdate('sync-step-2'))

    expect(mocks.sent).toHaveLength(1)
    expect(mocks.sent[0]).toMatchObject({
      windowId: 3,
      channel: CRDT_EVENTS.STATE_CHANGED,
      payload: {
        noteId: 'note-1',
        origin: 'ipc'
      }
    })
    expect(queue.enqueue).toHaveBeenCalled()
    expect(mocks.scheduleWriteback).toHaveBeenCalledWith('note-1', expect.any(Y.Doc))
  })

  it('skips remote updates for unopened docs and network-origin local queueing', async () => {
    provider.applyRemoteUpdate('missing-note', new Uint8Array(makeRemoteUpdate('remote')))
    expect(mocks.recordNetworkUpdate).not.toHaveBeenCalled()
    expect(queue.enqueue).not.toHaveBeenCalled()

    await provider.open('note-1', undefined, { skipSeed: true })
    provider.applyRemoteUpdate('note-1', new Uint8Array(makeRemoteUpdate('remote')))

    expect(mocks.recordNetworkUpdate).toHaveBeenCalledWith('note-1')
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('compacts closed docs, persists compacted state, and skips compaction while editors are open', async () => {
    const compactedDoc = new Y.Doc()
    compactedDoc.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [new Y.XmlText('compact')])
    const compacted = Y.encodeStateAsUpdate(compactedDoc)
    mocks.compactYDoc.mockReturnValue({ compacted, savedBytes: 120 })

    await provider.open('note-1', undefined, { skipSeed: true })
    provider.updateMeta('note-1', { title: 'Needs compaction' })

    await provider.compactDoc('note-1')

    expect(pushSnapshot).toHaveBeenCalledWith('note-1', compacted)
    expect(mocks.persistenceInstances[0].storeUpdate).toHaveBeenCalledWith('note-1', compacted)
    expect(mocks.persistenceInstances[0].flushDocument).toHaveBeenCalledWith('note-1')
    expect(provider.getDocSizeMetrics()[0]).toEqual(
      expect.objectContaining({ noteId: 'note-1', accumulatedBytes: 0 })
    )

    createWindow(4)
    await provider.open('open-note', 4, { skipSeed: true })
    mocks.compactYDoc.mockClear()
    await provider.compactDoc('open-note')
    expect(mocks.compactYDoc).not.toHaveBeenCalled()
  })

  it('buffers remote updates that arrive while a doc is being compacted', async () => {
    const compactedDoc = new Y.Doc()
    compactedDoc.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [new Y.XmlText('compact')])
    const compacted = Y.encodeStateAsUpdate(compactedDoc)
    mocks.compactYDoc.mockReturnValue({ compacted, savedBytes: 120 })

    await provider.open('note-1', undefined, { skipSeed: true })
    provider.updateMeta('note-1', { title: 'Before compaction' })
    pushSnapshot.mockImplementationOnce(async () => {
      provider.applyRemoteUpdate(
        'note-1',
        new Uint8Array(makeRemoteUpdate('Buffered remote title'))
      )
    })

    await provider.compactDoc('note-1')

    expect(provider.getDoc('note-1')?.getMap('meta').get('title')).toBe('Buffered remote title')
    expect(mocks.persistenceInstances[0].storeUpdate).toHaveBeenCalledWith('note-1', compacted)
  })

  it('persists, broadcasts and writes back the remote updates buffered by a successful compaction', async () => {
    // A store that actually stores: storeUpdate appends, getYDoc replays. A
    // lost update then shows up as missing content after a restart rather than
    // as a mock-call shape.
    const stored: Uint8Array[] = []
    const wireStore = (store: (typeof mocks.persistenceInstances)[number]): void => {
      store.storeUpdate.mockImplementation(async (_noteId: string, update: Uint8Array) => {
        stored.push(update)
      })
      store.getYDoc.mockImplementation(async () => {
        const doc = new Y.Doc()
        for (const update of stored) Y.applyUpdate(doc, update)
        return doc
      })
    }
    wireStore(mocks.persistenceInstances[0])

    // The compacted snapshot touches only the body fragment and the remote
    // update only meta.title, so the merged state is deterministic instead of
    // resolved by client id.
    const compactedDoc = new Y.Doc()
    compactedDoc.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [new Y.XmlText('compact')])
    mocks.compactYDoc.mockReturnValue({
      compacted: Y.encodeStateAsUpdate(compactedDoc),
      savedBytes: 120
    })

    await provider.open('note-1', undefined, { skipSeed: true })
    provider.updateMeta('note-1', { date: '2026-01-01' })
    expect(mocks.scheduleWriteback).not.toHaveBeenCalled()

    // A sync pull lands while the compaction is parked on its snapshot push,
    // so applyRemoteUpdate diverts it into the compaction buffer.
    pushSnapshot.mockImplementationOnce(async () => {
      provider.applyRemoteUpdate('note-1', makeRemoteUpdate('pulled during compaction'))
    })

    await provider.compactDoc('note-1')

    const compactedLiveDoc = provider.getDoc('note-1')

    // The queued network broadcast reaches the editor: the user reopens the
    // note, then the batcher flushes on shutdown.
    createWindow(9)
    await provider.open('note-1', 9, { skipSeed: true })
    await provider.destroy()

    const broadcast = mocks.sent.find(
      (sent) => sent.windowId === 9 && sent.channel === CRDT_EVENTS.STATE_CHANGED
    )
    const broadcastDoc = new Y.Doc()
    if (broadcast) Y.applyUpdate(broadcastDoc, (broadcast.payload as { update: Uint8Array }).update)

    // A restart must still see it, i.e. it is readable back out of the store.
    const restarted = new CrdtProvider()
    await restarted.init(queue as any, pushSnapshot)
    wireStore(mocks.persistenceInstances[mocks.persistenceInstances.length - 1])
    const reloaded = await restarted.open('note-1', undefined, { skipSeed: true })

    // Asserted together so a regression reports every limb it broke, not just
    // the first one.
    expect({
      inMemory: compactedLiveDoc?.getMap('meta').get('title'),
      writtenBackDoc: mocks.scheduleWriteback.mock.calls.at(-1),
      broadcastToEditor: broadcastDoc.getMap('meta').get('title'),
      afterRestart: reloaded.getMap('meta').get('title'),
      // Control: the pre-compaction local edit must survive the same round trip.
      dateAfterRestart: reloaded.getMap('meta').get('date')
    }).toEqual({
      inMemory: 'pulled during compaction',
      writtenBackDoc: ['note-1', compactedLiveDoc],
      broadcastToEditor: 'pulled during compaction',
      afterRestart: 'pulled during compaction',
      dateAfterRestart: '2026-01-01'
    })

    await restarted.destroy()
  })

  it('does not re-store or re-broadcast the compacted snapshot itself', async () => {
    const compactedDoc = new Y.Doc()
    compactedDoc.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [new Y.XmlText('compact')])
    const compacted = Y.encodeStateAsUpdate(compactedDoc)
    mocks.compactYDoc.mockReturnValue({ compacted, savedBytes: 120 })

    await provider.open('note-1', undefined, { skipSeed: true })
    provider.updateMeta('note-1', { date: '2026-01-01' })

    pushSnapshot.mockImplementationOnce(async () => {
      provider.applyRemoteUpdate('note-1', makeRemoteUpdate('pulled during compaction'))
    })

    await provider.compactDoc('note-1')

    const store = mocks.persistenceInstances[0]
    const storedUpdates = store.storeUpdate.mock.calls.map(([, update]) => update as Uint8Array)

    // The snapshot is written by compactDoc itself; seeding newDoc with it must
    // not send it through onDocUpdate and store it a second time.
    expect(storedUpdates.filter((update) => update === compacted)).toHaveLength(1)

    // The buffered update reaches the store exactly once, not once per path.
    const carriesRemoteTitle = (update: Uint8Array): boolean => {
      const probe = new Y.Doc()
      Y.applyUpdate(probe, update)
      return probe.getMap('meta').get('title') === 'pulled during compaction'
    }
    expect(storedUpdates.filter(carriesRemoteTitle)).toHaveLength(1)
    expect(mocks.scheduleWriteback).toHaveBeenCalledTimes(1)
  })

  it('keeps a local edit that lands during the compaction push eligible for the next snapshot', async () => {
    const compactedDoc = new Y.Doc()
    compactedDoc.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [new Y.XmlText('compact')])
    mocks.compactYDoc.mockReturnValue({
      compacted: Y.encodeStateAsUpdate(compactedDoc),
      savedBytes: 120
    })

    await provider.open('note-1', undefined, { skipSeed: true })
    provider.updateMeta('note-1', { date: '2026-01-01' })

    // crdt:apply-update routes straight to applyIpcUpdate, which has no
    // compaction guard (only remote updates are buffered), so a keystroke can
    // reach entry.doc after compactYDoc already encoded the payload being
    // pushed here.
    const typed = makeRemoteUpdate('typed during the push')
    pushSnapshot.mockImplementationOnce(async () => {
      provider.applyIpcUpdate('note-1', typed, 1)
    })

    await provider.compactDoc('note-1')

    // Those bytes are not in the pushed payload, so the note must stay armed
    // instead of reading as fully pushed.
    expect(provider.getDocSizeMetrics()[0].pendingSnapshotBytes).toBe(typed.byteLength)
    pushSnapshot.mockClear()
    await expect(provider.pushAllSnapshots()).resolves.toBe(1)
  })

  it('re-pushes a local edit that landed while an abandoned compaction was pushing', async () => {
    const compactedDoc = new Y.Doc()
    compactedDoc.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [new Y.XmlText('compact')])
    mocks.compactYDoc.mockReturnValue({
      compacted: Y.encodeStateAsUpdate(compactedDoc),
      savedBytes: 120
    })

    const originalDoc = await provider.open('note-1', undefined, { skipSeed: true })
    provider.updateMeta('note-1', { date: '2026-01-01' })

    // The editor reopens the note mid-compaction: open() adds the window to the
    // same entry, the keystroke that follows lands on the pre-compaction doc,
    // and the swap is then abandoned — so this edit lives only in originalDoc
    // and only a later snapshot push can carry it to the server.
    pushSnapshot.mockImplementationOnce(async () => {
      await provider.open('note-1', 42, { skipSeed: true })
      provider.applyIpcUpdate('note-1', makeRemoteUpdate('typed after reopen'), 42)
    })

    await provider.compactDoc('note-1')

    expect(provider.getDoc('note-1')).toBe(originalDoc)

    pushSnapshot.mockClear()
    await expect(provider.pushAllSnapshots()).resolves.toBe(1)
    const roundTrip = new Y.Doc()
    Y.applyUpdate(roundTrip, pushSnapshot.mock.calls[0][1] as Uint8Array)
    expect(roundTrip.getMap('meta').get('title')).toBe('typed after reopen')
  })

  it('abandons the compacted swap if an editor opens during compaction', async () => {
    const compactedDoc = new Y.Doc()
    compactedDoc.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [new Y.XmlText('compact')])
    mocks.compactYDoc.mockReturnValue({
      compacted: Y.encodeStateAsUpdate(compactedDoc),
      savedBytes: 120
    })

    const originalDoc = await provider.open('note-1', undefined, { skipSeed: true })
    provider.updateMeta('note-1', { title: 'Before compaction' })
    pushSnapshot.mockImplementationOnce(async () => {
      ;(provider as any).docs.get('note-1').windowIds.add(42)
    })

    await provider.compactDoc('note-1')

    expect(provider.getDoc('note-1')).toBe(originalDoc)
    expect(provider.getDocSizeMetrics()[0]).toEqual(
      expect.objectContaining({ noteId: 'note-1', windowCount: 1 })
    )
  })

  it('does not start compacting a doc that close() is already retiring', async () => {
    const compactedDoc = new Y.Doc()
    compactedDoc.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [new Y.XmlText('compact')])
    mocks.compactYDoc.mockReturnValue({
      compacted: Y.encodeStateAsUpdate(compactedDoc),
      savedBytes: 120
    })

    await provider.open('note-1', undefined, { skipSeed: true })
    provider.updateMeta('note-1', { title: 'Before close' })

    // Hold close() at its snapshot push: the entry is marked closing but the
    // map still holds it, which is exactly what checkAndCompact's setImmediate
    // sees when eviction and compaction fire on the same windowless doc.
    let releaseClosePush: (() => void) | undefined
    pushSnapshot.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseClosePush = resolve
        })
    )
    const closePromise = provider.close('note-1')
    await Promise.resolve()

    mocks.compactYDoc.mockClear()
    await provider.compactDoc('note-1')
    expect(mocks.compactYDoc).not.toHaveBeenCalled()

    releaseClosePush?.()
    await closePromise
    expect(provider.getDoc('note-1')).toBeUndefined()
  })

  it('abandons the compacted swap when close() starts mid-compaction', async () => {
    const compactedDoc = new Y.Doc()
    compactedDoc.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [new Y.XmlText('compact')])
    mocks.compactYDoc.mockReturnValue({
      compacted: Y.encodeStateAsUpdate(compactedDoc),
      savedBytes: 120
    })

    const originalDoc = await provider.open('note-1', undefined, { skipSeed: true })
    provider.updateMeta('note-1', { title: 'Before compaction' })

    // Start close() from inside the compaction's persistence write, and park it
    // on its own flush: the entry stays in the map, just marked closing.
    let closePromise: Promise<void> | undefined
    let releaseCloseFlush: (() => void) | undefined
    mocks.persistenceInstances[0].storeUpdate.mockImplementationOnce(async () => {
      mocks.persistenceInstances[0].flushDocument.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseCloseFlush = resolve
          })
      )
      closePromise = provider.close('note-1')
      await Promise.resolve()
    })

    await provider.compactDoc('note-1')

    // No swap onto a doc that close() is about to destroy.
    expect(provider.getDoc('note-1')).toBe(originalDoc)

    releaseCloseFlush?.()
    await closePromise
    expect(provider.getDoc('note-1')).toBeUndefined()
  })

  it('replays buffered remote updates onto the live doc when a reopen replaces the entry mid-compaction', async () => {
    const compactedDoc = new Y.Doc()
    compactedDoc.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [new Y.XmlText('compact')])
    mocks.compactYDoc.mockReturnValue({
      compacted: Y.encodeStateAsUpdate(compactedDoc),
      savedBytes: 120
    })

    createWindow(6)
    await provider.open('note-1', undefined, { skipSeed: true })
    provider.updateMeta('note-1', { title: 'Before compaction' })

    // Suspend the compaction inside its snapshot push and run the production
    // sequence in that window: eviction closes the windowless doc, the editor
    // reopens the note onto a fresh entry, then a sync pull lands.
    let reopenedDoc: Y.Doc | undefined
    pushSnapshot.mockImplementationOnce(async () => {
      await provider.close('note-1')
      reopenedDoc = await provider.open('note-1', 6, { skipSeed: true })
      provider.applyRemoteUpdate('note-1', makeRemoteUpdate('pulled after reopen'))
    })

    await provider.compactDoc('note-1')

    // The compaction belongs to the retired entry, so it must not touch the
    // live doc — and the update it swallowed must still reach that doc.
    expect(provider.getDoc('note-1')).toBe(reopenedDoc)
    expect(reopenedDoc?.isDestroyed).toBe(false)
    expect(provider.getDoc('note-1')?.getMap('meta').get('title')).toBe('pulled after reopen')
  })

  it('keeps a reopened doc alive if close races with a new open', async () => {
    let releaseFlush: (() => void) | undefined
    mocks.persistenceInstances[0].flushDocument.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFlush = resolve
        })
    )
    await provider.open('note-1', undefined, { skipSeed: true })

    const closePromise = provider.close('note-1')
    await Promise.resolve()

    const replacementDoc = new Y.Doc({ guid: 'note-1:replacement' })
    ;(provider as any).docs.set('note-1', {
      doc: replacementDoc,
      windowIds: new Set(),
      accumulatedBytes: 0,
      pendingSnapshotBytes: 0,
      lastEncodedSize: 0,
      lastSizeCheckAt: 0
    })

    releaseFlush?.()
    await closePromise

    expect(provider.getDoc('note-1')).toBe(replacementDoc)
  })

  it('destroys the superseded doc when a real reopen replaces it mid-close', async () => {
    createWindow(5)
    let releaseFlush: (() => void) | undefined
    mocks.persistenceInstances[0].flushDocument.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFlush = resolve
        })
    )
    const supersededDoc = await provider.open('note-1', undefined, { skipSeed: true })

    const closePromise = provider.close('note-1')
    await Promise.resolve()

    // A real reopen through open() — the editor mounting again while the
    // close's flush is still in flight — not a hand-built map entry.
    const replacementDoc = await provider.open('note-1', 5, { skipSeed: true })
    expect(replacementDoc).not.toBe(supersededDoc)

    releaseFlush?.()
    await closePromise

    // The live doc must survive: the map still points at it and keystrokes
    // arriving after the race still land in it.
    expect(provider.getDoc('note-1')).toBe(replacementDoc)
    expect(replacementDoc.isDestroyed).toBe(false)
    provider.applyIpcUpdate('note-1', makeRemoteUpdate('typed after reopen'), 5)
    expect(replacementDoc.getMap('meta').get('title')).toBe('typed after reopen')

    // The orphan is torn down instead of being left for GC with its 'update'
    // listener still attached.
    expect(supersededDoc.isDestroyed).toBe(true)
  })

  it('returns false when pushing a snapshot without a configured push callback', async () => {
    const noSnapshotProvider = new CrdtProvider()
    await noSnapshotProvider.init()

    await expect(noSnapshotProvider.pushSnapshotForNote('note-1')).resolves.toBe(false)

    await noSnapshotProvider.destroy()
  })

  it('stops seedExistingDocs on abort and skips docs with persisted content', async () => {
    const existing = new Y.Doc()
    existing.getMap('meta').set('title', 'Already persisted')
    mocks.persistenceInstances[0].getYDoc.mockResolvedValueOnce(existing)

    const seeded = await provider.seedExistingDocs([{ id: 'already-seeded', title: 'Ignored' }])
    expect(seeded).toBe(0)

    const controller = new AbortController()
    controller.abort()

    await expect(
      provider.seedExistingDocs([{ id: 'aborted', title: 'Aborted' }], vi.fn(), controller.signal)
    ).resolves.toBe(0)
  })

  it('tells every window to rebind its editors when the provider is reset', async () => {
    // #given two windows and a note an editor holds open in the live singleton
    createWindow(1)
    createWindow(2)
    const singleton = getCrdtProvider()
    await singleton.init(queue as any, pushSnapshot)
    await singleton.open('note-open', 1, { skipSeed: true })
    expect(singleton.strandedEditorDocCount).toBe(1)
    mocks.sent = []

    // #when the provider is dropped, as sign-out does
    resetCrdtProvider()

    // #then every window has to hear it, not just the one holding the note: each
    // renderer provider is bound to a doc this instance owned, and without the
    // event it keeps that dead binding, so main applies remote updates to the
    // fresh instance and broadcasts them to a window set the editor is not in.
    const rebinds = mocks.sent.filter((sent) => sent.channel === CRDT_EVENTS.PROVIDER_RESET)
    expect(rebinds.map((sent) => sent.windowId).sort()).toEqual([1, 2])

    // #and the reset must NOT read as "you may re-open now". At this instant the
    // old provider is destroyed and no replacement is initialized, so every
    // OPEN_DOC is rejected — a window that treated the reset as its cue to
    // re-open failed on every attempt and stayed unbound for good.
    expect(mocks.sent.some((sent) => sent.channel === CRDT_EVENTS.PROVIDER_READY)).toBe(false)
    expect(getCrdtProvider().isInitialized()).toBe(false)
  })

  it('announces readiness only once persistence is up and open-doc will succeed', async () => {
    // #given the windows holding stranded editors after a reset
    createWindow(1)
    createWindow(2)
    resetCrdtProvider()
    mocks.sent = []

    // #when a provider is brought up — bootstrap, or the sync runtime's init()
    // after a vault open / sign-in
    const replacement = getCrdtProvider()
    const initializedWhenAnnounced: boolean[] = []
    for (const [windowId, win] of mocks.windows) {
      win.webContents.send.mockImplementation((channel: string, payload: unknown) => {
        if (channel === CRDT_EVENTS.PROVIDER_READY) {
          initializedWhenAnnounced.push(replacement.isInitialized())
        }
        mocks.sent.push({ windowId, channel, payload })
      })
    }
    await replacement.initPersistence()

    // #then every window hears it, not just the one holding a note — one
    // provider serves every open doc, so one announcement releases them all.
    const readies = mocks.sent.filter((sent) => sent.channel === CRDT_EVENTS.PROVIDER_READY)
    expect(readies.map((sent) => sent.windowId).sort()).toEqual([1, 2])

    // #and it is announced from the exact assignment OPEN_DOC gates on:
    // announcing any earlier sends the stranded editors straight back into the
    // 'CRDT provider not initialized' rejection this whole signal exists to end.
    expect(initializedWhenAnnounced).toEqual([true, true])
  })

  it('still reports the editors it stranded after destroy has emptied the doc map', async () => {
    // #given sign-out wipes storage (which destroys) before it resets the singleton
    createWindow(1)
    const singleton = getCrdtProvider()
    await singleton.init(queue as any, pushSnapshot)
    await singleton.open('note-open', 1, { skipSeed: true })
    await singleton.destroy()

    // #then the count must survive that, or the one number saying how many editors
    // a reset broke is always zero by the time it is read
    expect(singleton.strandedEditorDocCount).toBe(1)
  })

  it('covers provider singleton, idempotent init, and destroy lifecycle', async () => {
    const singleton = getCrdtProvider()
    expect(getCrdtProvider()).toBe(singleton)
    resetCrdtProvider()
    expect(getCrdtProvider()).not.toBe(singleton)

    await provider.initPersistence()
    await provider.initPersistence()
    expect(mocks.persistenceInstances).toHaveLength(1)

    const noSnapshotProvider = new CrdtProvider()
    await noSnapshotProvider.init()
    await noSnapshotProvider.open('note-1', undefined, { skipSeed: true })
    noSnapshotProvider.updateMeta('note-1', { title: 'No snapshot callback' })
    await expect(noSnapshotProvider.pushAllSnapshots()).resolves.toBe(0)
    await noSnapshotProvider.destroy()

    await provider.destroy()
    expect(mocks.persistenceInstances[0].destroy).toHaveBeenCalled()
    expect(provider.isInitialized()).toBe(false)
  })

  it('handles close, destroy, and push snapshot failures without leaking docs', async () => {
    createWindow(11, true)
    await provider.open('note-1', 11, { skipSeed: true })
    provider.updateMeta('note-1', { title: 'Will close' })
    pushSnapshot.mockRejectedValueOnce(new Error('snapshot failed'))
    mocks.persistenceInstances[0].flushDocument.mockRejectedValueOnce(new Error('flush failed'))

    await provider.close('note-1')

    expect(pushSnapshot).toHaveBeenCalledWith('note-1', expect.any(Uint8Array))
    expect(provider.getDoc('note-1')).toBeUndefined()

    await provider.open('note-1', undefined, { skipSeed: true })
    mocks.persistenceInstances[0].flushDocument.mockRejectedValueOnce(new Error('destroy flush'))
    mocks.persistenceInstances[0].destroy.mockRejectedValueOnce(new Error('destroy failed'))

    await provider.destroy()

    expect(provider.getOpenNoteIds()).toEqual([])
    expect(mocks.persistenceInstances[0].destroy).toHaveBeenCalled()
  })

  it('returns false when snapshot pushing fails and closes docs it opened itself', async () => {
    pushSnapshot.mockRejectedValueOnce(new Error('server offline'))

    await expect(provider.pushSnapshotForNote('note-1')).resolves.toBe(false)

    expect(provider.getDoc('note-1')).toBeUndefined()
  })

  it('skips markdown seeding for missing, binary, empty, and conversion-failed notes', async () => {
    await provider.open('missing-note', undefined, { skipSeed: true })
    mocks.getNoteCacheById.mockReturnValueOnce(null)
    await provider.seedFromMarkdownPublic('missing-note')
    expect(mocks.safeRead).not.toHaveBeenCalledWith('/vault/undefined')

    await provider.open('binary-note', undefined, { skipSeed: true })
    mocks.getNoteCacheById.mockReturnValueOnce({
      id: 'binary-note',
      path: 'notes/file.pdf',
      fileType: 'pdf'
    })
    await provider.seedFromMarkdownPublic('binary-note')
    expect(mocks.safeRead).not.toHaveBeenCalledWith('/vault/notes/file.pdf')

    await provider.open('empty-note', undefined, { skipSeed: true })
    mocks.getNoteCacheById.mockReturnValueOnce({
      id: 'empty-note',
      path: 'notes/empty.md',
      fileType: 'markdown'
    })
    mocks.safeRead.mockResolvedValueOnce('')
    await provider.seedFromMarkdownPublic('empty-note')
    expect(mocks.markdownToYFragment).not.toHaveBeenCalledWith('', expect.anything())
    // Nothing to seed, but the bytes WERE read: the hash is recorded so the
    // write-back's never-read guard lets the first keystroke into this empty
    // file reach the disk (#1909).
    expect(mocks.updateNoteCache).toHaveBeenCalledWith(expect.anything(), 'empty-note', {
      contentHash: 'hash:'
    })

    await provider.open('blank-note', undefined, { skipSeed: true })
    mocks.getNoteCacheById.mockReturnValueOnce({
      id: 'blank-note',
      path: 'notes/blank.md',
      fileType: 'markdown'
    })
    mocks.safeRead.mockResolvedValueOnce('---\n---\n')
    mocks.parseNote.mockReturnValueOnce({ content: '   ' })
    await provider.seedFromMarkdownPublic('blank-note')
    expect(mocks.markdownToYFragment).not.toHaveBeenCalledWith('   ', expect.anything())

    await provider.open('failed-convert', undefined, { skipSeed: true })
    mocks.getNoteCacheById.mockReturnValueOnce({
      id: 'failed-convert',
      path: 'notes/failed.md',
      fileType: 'markdown'
    })
    mocks.safeRead.mockResolvedValueOnce('Body')
    mocks.parseNote.mockReturnValueOnce({ content: 'Body' })
    mocks.markdownToYFragment.mockResolvedValueOnce(false)
    mocks.persistenceInstances[0].storeUpdate.mockClear()
    await provider.seedFromMarkdownPublic('failed-convert')
    expect(mocks.persistenceInstances[0].storeUpdate).not.toHaveBeenCalled()
  })

  it('records the hash of the bytes a seed was built from, so the first edit can save (#1909)', async () => {
    await provider.open('foreign-note', undefined, { skipSeed: true })
    mocks.getNoteCacheById.mockReturnValue({
      id: 'foreign-note',
      path: 'notes/Foreign.md',
      fileType: 'markdown',
      contentHash: null
    })
    mocks.safeRead.mockResolvedValueOnce('Line one  \nLine two')
    mocks.parseNote.mockReturnValueOnce({ content: 'Line one  \nLine two' })

    await provider.seedFromMarkdownPublic('foreign-note')

    expect(mocks.updateNoteCache).toHaveBeenCalledWith(expect.anything(), 'foreign-note', {
      contentHash: 'hash:Line one  \nLine two'
    })
  })

  it('leaves a hash the indexer already measured alone', async () => {
    await provider.open('indexed-note', undefined, { skipSeed: true })
    mocks.getNoteCacheById.mockReturnValue({
      id: 'indexed-note',
      path: 'notes/Indexed.md',
      fileType: 'markdown',
      contentHash: 'hash:what the indexer read'
    })
    mocks.safeRead.mockResolvedValueOnce('what the indexer read')
    mocks.parseNote.mockReturnValueOnce({ content: 'what the indexer read' })

    await provider.seedFromMarkdownPublic('indexed-note')

    expect(mocks.updateNoteCache).not.toHaveBeenCalledWith(
      expect.anything(),
      'indexed-note',
      expect.objectContaining({ contentHash: expect.anything() })
    )
  })

  it('records no hash when the conversion fails, since the doc does not hold the bytes', async () => {
    await provider.open('seed-failed', undefined, { skipSeed: true })
    mocks.getNoteCacheById.mockReturnValue({
      id: 'seed-failed',
      path: 'notes/Failed.md',
      fileType: 'markdown',
      contentHash: null
    })
    mocks.safeRead.mockResolvedValueOnce('Body')
    mocks.parseNote.mockReturnValueOnce({ content: 'Body' })
    mocks.markdownToYFragment.mockResolvedValueOnce(false)

    await provider.seedFromMarkdownPublic('seed-failed')

    expect(mocks.updateNoteCache).not.toHaveBeenCalledWith(
      expect.anything(),
      'seed-failed',
      expect.objectContaining({ contentHash: expect.anything() })
    )
  })

  it('refuses to seed a log dump that is under the byte ceiling but one giant block', async () => {
    // #given 600 KB of log lines with no blank line anywhere — the reported
    // freeze. A byte ceiling alone would accept this file.
    const dump = Array.from({ length: 20_000 }, (_, i) => `2026-08-15 line ${i} payload`).join('\n')
    await provider.open('log-dump', undefined, { skipSeed: true })
    mocks.getNoteCacheById.mockReturnValueOnce({
      id: 'log-dump',
      path: 'notes/dump.md',
      fileType: 'markdown'
    })
    mocks.safeRead.mockResolvedValueOnce(dump)
    mocks.markdownToYFragment.mockClear()
    mocks.persistenceInstances[0].storeUpdate.mockClear()

    // #when
    await provider.seedFromMarkdownPublic('log-dump')

    // #then — the BlockNote parse is the freeze, so it must never be reached,
    // and nothing is persisted for the note.
    expect(mocks.markdownToYFragment).not.toHaveBeenCalled()
    expect(mocks.persistenceInstances[0].storeUpdate).not.toHaveBeenCalled()
    expect(provider.getDoc('log-dump')?.getXmlFragment('prosemirror').length).toBe(0)
  })

  it('refuses a file over the byte ceiling without reading it', async () => {
    // #given a real file past NOTE_MAX_BYTES on disk. The vault-wide sweep
    // reaches every note on every pass, and the reported case was 17 MB read
    // in full each time only to be refused.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-crdt-seed-'))
    const file = path.join(dir, 'dump.md')
    fs.writeFileSync(file, 'x'.repeat(NOTE_MAX_BYTES + 1))
    mocks.toAbsolutePath.mockReturnValue(file)

    await provider.open('big-on-disk', undefined, { skipSeed: true })
    mocks.getNoteCacheById.mockReturnValueOnce({
      id: 'big-on-disk',
      path: 'notes/dump.md',
      fileType: 'markdown'
    })
    mocks.safeRead.mockClear()
    mocks.markdownToYFragment.mockClear()

    // #when
    await provider.seedFromMarkdownPublic('big-on-disk')

    // #then — `stat` settles it, so the bytes are never pulled into the main
    // process at all
    expect(mocks.safeRead).not.toHaveBeenCalled()
    expect(mocks.markdownToYFragment).not.toHaveBeenCalled()

    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('refuses to seed a file over the byte ceiling', async () => {
    // #given a file past NOTE_MAX_BYTES, shaped as ordinary paragraphs
    const huge = Array.from({ length: 3000 }, () => 'x'.repeat(1000)).join('\n\n')
    await provider.open('huge-note', undefined, { skipSeed: true })
    mocks.getNoteCacheById.mockReturnValueOnce({
      id: 'huge-note',
      path: 'notes/huge.md',
      fileType: 'markdown'
    })
    mocks.safeRead.mockResolvedValueOnce(huge)
    mocks.markdownToYFragment.mockClear()

    // #when
    await provider.seedFromMarkdownPublic('huge-note')

    // #then
    expect(mocks.markdownToYFragment).not.toHaveBeenCalled()
  })

  it('still seeds a well-formed 800 KB note, which parses fine', async () => {
    // #given the measured good case: big, but many blank-line-separated blocks
    const body = Array.from({ length: 200 }, () => 'x'.repeat(4000)).join('\n\n')
    await provider.open('big-but-fine', undefined, { skipSeed: true })
    mocks.getNoteCacheById.mockReturnValueOnce({
      id: 'big-but-fine',
      path: 'notes/big.md',
      fileType: 'markdown'
    })
    mocks.safeRead.mockResolvedValueOnce(body)
    mocks.parseNote.mockReturnValueOnce({ content: body })
    mocks.markdownToYFragment.mockClear()

    // #when
    await provider.seedFromMarkdownPublic('big-but-fine')

    // #then — the guard must not cost the app notes it can genuinely handle
    expect(mocks.markdownToYFragment).toHaveBeenCalledWith(body, expect.anything(), 'notes/big.md')
  })

  it('ignores closing docs and unavailable windows while applying updates', async () => {
    createWindow(21, true)
    await provider.open('closing-note', 21, { skipSeed: true })
    ;(provider as any).docs.get('closing-note').closing = true

    provider.applyRemoteUpdate('closing-note', new Uint8Array(makeRemoteUpdate('ignored')))
    expect(mocks.recordNetworkUpdate).not.toHaveBeenCalled()
    ;(provider as any).docs.get('closing-note').closing = false
    provider.applyIpcUpdate('closing-note', makeRemoteUpdate('local'), 99)
    expect(mocks.sent).toEqual([])
  })

  // An edit made with no session reaches the doc and the local store — that has
  // been true since the provider stopped being gated on a session. What it did
  // NOT reach was anything that remembers the server is owed it: `init(queue)`
  // runs only from startSyncRuntime, so signed out there is no update queue,
  // and the queue's own shutdown recorder can only report updates it accepted.
  // The edit was safe locally and invisible to every other device forever.
  describe('signed-out CRDT backlog', () => {
    const pendingStoreFile = (): string => path.join(mocks.userDataDir, 'crdt-pending-notes.json')

    beforeEach(() => {
      fs.rmSync(pendingStoreFile(), { force: true })
    })

    afterEach(() => {
      fs.rmSync(pendingStoreFile(), { force: true })
    })

    it('pushes an edit made with no session once the session comes back, with no further input', async () => {
      // #given the provider as it exists after sign-out: persistence re-opened
      // (session-teardown does that), no update queue, no snapshot push fn
      const signedOut = new CrdtProvider()
      await signedOut.init()

      // #when the user types
      const doc = await signedOut.open('note-1', 1, { skipSeed: true })
      doc.getMap('meta').set('title', 'typed while signed out')

      // #then nothing in the live sync path saw it — there is nothing to see it
      expect(queue.enqueue).not.toHaveBeenCalled()
      // #and the debt is durable, which is the only thing that can outlive this
      expect(readPendingCrdtNotes()).toEqual(['note-1'])

      // #when the user signs back in. startSyncRuntime calls init() on THIS
      // instance — sign-out already reset the singleton, sign-in does not — and
      // then fires the replay. No editing, no clicking, no restart.
      const pushAfterSignIn = vi.fn<SnapshotPushFn>().mockResolvedValue(undefined)
      await signedOut.init(queue as any, pushAfterSignIn)
      const replayed = await drainPendingCrdtNotes({
        mergeRemote: async () => true,
        pushSnapshot: (noteId) => signedOut.pushSnapshotForNote(noteId),
        isSyncable: (noteId) => signedOut.validateNoteForCrdt(noteId).ok
      })

      // #then the note's full state reaches the server. Full state is the only
      // shape available: a queue-less edit produced no incrementals to replay.
      expect(replayed).toEqual({ cleared: 1, retained: 0 })
      expect(pushAfterSignIn).toHaveBeenCalledTimes(1)
      expect(pushAfterSignIn.mock.calls[0]![0]).toBe('note-1')

      const received = new Y.Doc()
      Y.applyUpdate(received, pushAfterSignIn.mock.calls[0]![1])
      expect(received.getMap('meta').get('title')).toBe('typed while signed out')

      // #and the debt is settled, so the next replay does not pay for it again
      expect(readPendingCrdtNotes()).toEqual([])

      await signedOut.destroy()
    })

    // The server prunes every crdt_updates row at or below a stored snapshot's
    // sequence number, so a snapshot is an assertion that it contains
    // everything up to that point. Push one for a note whose peer edits this
    // device has not merged and those edits are deleted server-side AND absent
    // from the snapshot — destroyed for every device. The pending list is
    // precisely the notes this device edited while it could not push, so it is
    // also the population most likely to have diverged from a peer.
    it('keeps both sides of a note edited on two devices across a sign-out', async () => {
      // #given the same note edited on the peer while this device was signed out
      const peer = new Y.Doc()
      peer.getMap('meta').set('fromPeer', 'edited on device A')
      const peerUpdate = Y.encodeStateAsUpdate(peer)

      // #and this device's own signed-out edit, recorded with no queue
      const signedOut = new CrdtProvider()
      await signedOut.init()
      const doc = await signedOut.open('note-1', 1, { skipSeed: true })
      doc.getMap('meta').set('fromThisDevice', 'edited while signed out')
      expect(readPendingCrdtNotes()).toEqual(['note-1'])

      // #when the user signs in and the replay runs. mergeRemote stands in for
      // engine.mergeRemoteCrdtForNote, whose only effect on the doc is the
      // applyRemoteUpdate this performs.
      const pushAfterSignIn = vi.fn<SnapshotPushFn>().mockResolvedValue(undefined)
      await signedOut.init(queue as any, pushAfterSignIn)

      const order: string[] = []
      await drainPendingCrdtNotes({
        mergeRemote: async (noteId) => {
          order.push('merge')
          await signedOut.open(noteId, undefined, { skipSeed: true })
          signedOut.applyRemoteUpdate(noteId, peerUpdate)
          return true
        },
        pushSnapshot: async (noteId) => {
          order.push('push')
          return signedOut.pushSnapshotForNote(noteId)
        },
        isSyncable: (noteId) => signedOut.validateNoteForCrdt(noteId).ok
      })

      // #then the pull happened first — after the push it would be worthless,
      // the destructive prune has already run server-side by then.
      expect(order).toEqual(['merge', 'push'])

      // #and the snapshot the server is told to keep carries BOTH edits, so the
      // prune that follows it deletes nothing that is not already inside it.
      expect(pushAfterSignIn).toHaveBeenCalledTimes(1)
      const stored = new Y.Doc()
      Y.applyUpdate(stored, pushAfterSignIn.mock.calls[0]![1])
      expect(stored.getMap('meta').get('fromThisDevice')).toBe('edited while signed out')
      expect(stored.getMap('meta').get('fromPeer')).toBe('edited on device A')

      await signedOut.destroy()
    })

    it('does not push a note whose pre-push pull failed, and keeps it pending', async () => {
      const signedOut = new CrdtProvider()
      await signedOut.init()
      const doc = await signedOut.open('note-1', 1, { skipSeed: true })
      doc.getMap('meta').set('title', 'typed while signed out')

      const pushAfterSignIn = vi.fn<SnapshotPushFn>().mockResolvedValue(undefined)
      await signedOut.init(queue as any, pushAfterSignIn)

      const replayed = await drainPendingCrdtNotes({
        // What an offline start, an expired token, or a 429 on the baseline GET
        // looks like from here.
        mergeRemote: async () => false,
        pushSnapshot: (noteId) => signedOut.pushSnapshotForNote(noteId),
        isSyncable: (noteId) => signedOut.validateNoteForCrdt(noteId).ok
      })

      expect(pushAfterSignIn).not.toHaveBeenCalled()
      expect(replayed).toEqual({ cleared: 0, retained: 1 })
      // Still owed, so the next start or reconnect tries again rather than
      // dropping this device's signed-out edit.
      expect(readPendingCrdtNotes()).toEqual(['note-1'])

      await signedOut.destroy()
    })

    it('records nothing when there is an update queue to take the edit', async () => {
      // The queue owns the update from here: it flushes it as an incremental,
      // and its own stop()/budget paths record it if that flush never lands.
      // Recording here too would mean a redundant full-snapshot push per note.
      const doc = await provider.open('note-1', 1, { skipSeed: true })
      doc.getMap('meta').set('title', 'typed while signed in')

      expect(queue.enqueue).toHaveBeenCalledTimes(1)
      expect(readPendingCrdtNotes()).toEqual([])
    })

    it('writes once per note touched, not once per update', async () => {
      // This fires on roughly every keystroke, and recordPendingCrdtNotes is a
      // synchronous read-modify-write of a file in userData. Per update that is
      // a disk write per keystroke; per note it is negligible.
      const signedOut = new CrdtProvider()
      await signedOut.init()
      const doc = await signedOut.open('note-1', 1, { skipSeed: true })

      doc.getMap('meta').set('title', 'first')
      expect(readPendingCrdtNotes()).toEqual(['note-1'])

      // Blank the store behind the provider's back: any further write for this
      // note would put the id back, so the file staying empty is proof that no
      // second write happened.
      fs.writeFileSync(pendingStoreFile(), '[]', 'utf8')
      for (const title of ['second', 'third', 'fourth', 'fifth']) {
        doc.getMap('meta').set('title', title)
      }
      expect(readPendingCrdtNotes()).toEqual([])

      // A different note is still a different debt.
      const other = await signedOut.open('note-2', 1, { skipSeed: true })
      other.getMap('meta').set('title', 'other note')
      expect(readPendingCrdtNotes()).toEqual(['note-2'])

      await signedOut.destroy()
    })
  })

  // The record feed has always honoured this — `seedUnclockedNotes` excludes
  // `localOnly IS NOT 1`, and so does the offline clock — but the CRDT body
  // path did not, so a note the user marked local-only went on pushing its
  // *body* while its metadata stayed put. E2E-encrypted, so never a
  // confidentiality breach, but "local-only" reads as a promise, and the UI hid
  // the gap because the metadata genuinely did not sync.
  describe('a local-only note', () => {
    const pendingStoreFile = (): string => path.join(mocks.userDataDir, 'crdt-pending-notes.json')

    const noteRow = (localOnly: boolean): Record<string, unknown> => ({
      id: 'note-1',
      path: 'notes/Note.md',
      title: 'Note',
      fileType: 'markdown',
      localOnly
    })

    beforeEach(() => {
      fs.rmSync(pendingStoreFile(), { force: true })
    })

    afterEach(() => {
      fs.rmSync(pendingStoreFile(), { force: true })
    })

    it('never hands an edit to the update queue', async () => {
      mocks.getNoteCacheById.mockReturnValue(noteRow(true))
      createWindow(1)
      const doc = await provider.open('note-1', 1, { skipSeed: true })

      doc.getMap('meta').set('title', 'typed in a local-only note')

      expect(queue.enqueue).not.toHaveBeenCalled()
    })

    it('records no CRDT backlog when there is no update queue to take the edit', async () => {
      // The queue-less recorder exists to get a body to the server later. A
      // local-only note owes the server nothing, so there is nothing to record.
      mocks.getNoteCacheById.mockReturnValue(noteRow(true))
      const signedOut = new CrdtProvider()
      await signedOut.init()
      const doc = await signedOut.open('note-1', undefined, { skipSeed: true })

      doc.getMap('meta').set('title', 'typed while signed out')

      expect(readPendingCrdtNotes()).toEqual([])
      await signedOut.destroy()
    })

    it('refuses a snapshot push, from any caller', async () => {
      mocks.getNoteCacheById.mockReturnValue(noteRow(true))

      // The one push path reached for a note with no open doc — the pending
      // replay and the push coordinator's create both land here.
      expect(await provider.pushSnapshotForNote('note-1')).toBe(false)
      expect(pushSnapshot).not.toHaveBeenCalled()
    })

    it('pushes no snapshot when its last editor closes, nor at shutdown', async () => {
      // The debt is deliberately real — pendingSnapshotBytes counts what was
      // written and not pushed, for every note — so these two doors have to
      // refuse on the flag itself and nothing else can be doing the work.
      mocks.getNoteCacheById.mockReturnValue(noteRow(true))
      createWindow(1)
      const doc = await provider.open('note-1', 1, { skipSeed: true })
      doc.getMap('meta').set('title', 'typed in a local-only note')
      expect(provider.getDocSizeMetrics()[0]!.pendingSnapshotBytes).toBeGreaterThan(0)

      // Shutdown flush first: close() would otherwise consume the debt.
      expect(await provider.pushAllSnapshots()).toBe(0)
      await provider.close('note-1', 1)

      expect(pushSnapshot).not.toHaveBeenCalled()
    })

    it('pushes no snapshot when the compaction pass reaches it', async () => {
      // Third door, and the one that fires without any user action: the doc is
      // editor-less by definition here, so nothing on screen hints at a push.
      mocks.getNoteCacheById.mockReturnValue(noteRow(true))
      const compactedDoc = new Y.Doc()
      compactedDoc.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [new Y.XmlText('compact')])
      mocks.compactYDoc.mockReturnValue({
        compacted: Y.encodeStateAsUpdate(compactedDoc),
        savedBytes: 120
      })

      await provider.open('note-1', undefined, { skipSeed: true })
      provider.updateMeta('note-1', { title: 'Needs compaction' })
      await provider.compactDoc('note-1')

      // Compaction itself still happens — it is a local win — and only the push
      // is refused.
      expect(pushSnapshot).not.toHaveBeenCalled()
      expect(mocks.persistenceInstances[0].storeUpdate).toHaveBeenCalled()
    })

    it('still reaches the local doc, the local store, every window and the vault file', async () => {
      // The whole point: editing is untouched. Nothing here may depend on a
      // session, a plan or a network — only what leaves the machine changes.
      mocks.getNoteCacheById.mockReturnValue(noteRow(true))
      createWindow(1)
      createWindow(2)
      await provider.open('note-1', 1, { skipSeed: true })
      await provider.open('note-1', 2, { skipSeed: true })

      provider.applyIpcUpdate('note-1', makeRemoteUpdate('typed in a local-only note'), 1)

      expect(provider.getDoc('note-1')!.getMap('meta').get('title')).toBe(
        'typed in a local-only note'
      )
      expect(mocks.persistenceInstances[0].storeUpdate).toHaveBeenCalled()
      expect(mocks.sent).toHaveLength(1)
      expect(mocks.sent[0]).toMatchObject({
        windowId: 2,
        channel: CRDT_EVENTS.STATE_CHANGED,
        payload: { noteId: 'note-1', origin: 'ipc' }
      })
      expect(mocks.scheduleWriteback).toHaveBeenCalledWith('note-1', expect.any(Y.Doc))
    })

    it('costs an ordinary note nothing', async () => {
      mocks.getNoteCacheById.mockReturnValue(noteRow(false))
      createWindow(1)
      const doc = await provider.open('note-1', 1, { skipSeed: true })

      doc.getMap('meta').set('title', 'typed in a syncing note')
      expect(queue.enqueue).toHaveBeenCalledTimes(1)

      await provider.close('note-1', 1)
      expect(pushSnapshot).toHaveBeenCalledWith('note-1', expect.any(Uint8Array))
    })

    // Crosses the seam for real: the toggle is the shipped function, the flag
    // is resolved by the shipped doOpen, the edit is a real Yjs transaction and
    // the assertion is on what the update queue actually received. Both halves
    // mocked against each other is exactly what nearly shipped a broken #1489.
    it('starts pushing again the moment the real toggle clears it, with no reopen', async () => {
      // #given the singleton the toggle reaches, not this suite's instance
      const singleton = getCrdtProvider()
      await singleton.init(queue as never, pushSnapshot)

      // #and an index cache the toggle genuinely writes through
      const row = noteRow(true)
      mocks.getNoteCacheById.mockImplementation(() => row)
      mocks.updateNoteCache.mockImplementation((...args: unknown[]) =>
        Object.assign(row, args[2] as object)
      )

      createWindow(1)
      const doc = await singleton.open('note-1', 1, { skipSeed: true })
      doc.getMap('meta').set('title', 'written while local-only')
      expect(queue.enqueue).not.toHaveBeenCalled()

      // #when the user turns local-only off
      setNoteLocalOnlyState('note-1', false)

      // #then the very next keystroke goes up, without closing and reopening
      doc.getMap('meta').set('title', 'written after un-toggling')
      expect(queue.enqueue).toHaveBeenCalledTimes(1)
      expect(queue.enqueue.mock.calls[0]![0]).toBe('note-1')

      // #and the body written while it was local-only is not stranded. Nothing
      // else would push it: the push coordinator's snapshot is gated on
      // `operation === 'create'` and this raised an `update`, an update payload
      // carries `content: null`, and the vault sweep only pulls — so an
      // incremental carrying the last keystroke alone would leave every peer
      // with a body frozen where the server last saw it.
      expect(readPendingCrdtNotes()).toEqual(['note-1'])
      const replayed = await drainPendingCrdtNotes({
        mergeRemote: async () => true,
        pushSnapshot: (noteId) => singleton.pushSnapshotForNote(noteId),
        isSyncable: (noteId) => singleton.validateNoteForCrdt(noteId).ok
      })

      expect(replayed).toEqual({ cleared: 1, retained: 0 })
      const received = new Y.Doc()
      Y.applyUpdate(received, pushSnapshot.mock.calls.at(-1)![1])
      expect(received.getMap('meta').get('title')).toBe('written after un-toggling')

      await singleton.destroy()
    })

    it('hands its body to the merge-first replay when the toggle clears, not to a blind close()', async () => {
      const singleton = getCrdtProvider()
      await singleton.init(queue as never, pushSnapshot)
      const row = noteRow(true)
      mocks.getNoteCacheById.mockImplementation(() => row)
      mocks.updateNoteCache.mockImplementation((...args: unknown[]) =>
        Object.assign(row, args[2] as object)
      )

      createWindow(1)
      const doc = await singleton.open('note-1', 1, { skipSeed: true })
      doc.getMap('meta').set('title', 'written while local-only')

      setNoteLocalOnlyState('note-1', false)
      await singleton.close('note-1', 1)

      // close() pushes blind — it never pulls first — and a snapshot asserts
      // completeness, so the server prunes every incremental below it. A note
      // that has just stopped being local-only is the population most likely to
      // have diverged from a peer, so its body goes up through
      // drainPendingCrdtNotes, which merges before it pushes.
      expect(pushSnapshot).not.toHaveBeenCalled()
      expect(readPendingCrdtNotes()).toEqual(['note-1'])
      await singleton.destroy()
    })

    it('empties the update queue buffer the toggle cannot otherwise reach', async () => {
      // The guard is at enqueue time (`onDocUpdate`) but the queue flushes on a
      // ~1s loop, so everything typed in the second before the toggle is already
      // buffered and past it. `setNoteLocalOnlyState` clears the pending-note
      // store and zeroes the snapshot debt; neither reaches into the buffer.
      const singleton = getCrdtProvider()
      await singleton.init(queue as never, pushSnapshot)

      const row = noteRow(false)
      mocks.getNoteCacheById.mockImplementation(() => row)
      mocks.updateNoteCache.mockImplementation((...args: unknown[]) =>
        Object.assign(row, args[2] as object)
      )

      createWindow(1)
      const doc = await singleton.open('note-1', 1, { skipSeed: true })
      doc.getMap('meta').set('title', 'typed a moment before the toggle')
      expect(queue.enqueue).toHaveBeenCalledTimes(1)

      // #when the user marks it local-only before the flush loop ticks
      setNoteLocalOnlyState('note-1', true)

      // #then the buffered bytes are dropped rather than pushed on the next tick
      expect(queue.dropNote).toHaveBeenCalledWith('note-1')
      await singleton.destroy()
    })

    it('drops the queue buffer even for a note whose doc the LRU already evicted', async () => {
      // `setNoteLocalOnly` returns early when there is no open doc, so the drop
      // has to happen ahead of that lookup: a note can be enqueued and then have
      // its doc closed underneath it, leaving the buffer as the only holder.
      const singleton = getCrdtProvider()
      await singleton.init(queue as never, pushSnapshot)

      const row = noteRow(false)
      mocks.getNoteCacheById.mockImplementation(() => row)
      mocks.updateNoteCache.mockImplementation((...args: unknown[]) =>
        Object.assign(row, args[2] as object)
      )

      setNoteLocalOnlyState('note-1', true)

      expect(queue.dropNote).toHaveBeenCalledWith('note-1')
      await singleton.destroy()
    })

    it('drops a CRDT backlog the server is no longer owed when the real toggle sets it', async () => {
      // The CRDT twin of `removePendingNoteSyncItems`. Nothing is lost: the
      // updates stay in the local store, and clearing the flag re-records the
      // note, whose replay pushes full doc state and supersedes them.
      const singleton = getCrdtProvider()
      await singleton.init()

      const row = noteRow(false)
      mocks.getNoteCacheById.mockImplementation(() => row)
      mocks.updateNoteCache.mockImplementation((...args: unknown[]) =>
        Object.assign(row, args[2] as object)
      )

      const doc = await singleton.open('note-1', undefined, { skipSeed: true })
      doc.getMap('meta').set('title', 'typed while signed out')
      expect(readPendingCrdtNotes()).toEqual(['note-1'])

      setNoteLocalOnlyState('note-1', true)

      expect(readPendingCrdtNotes()).toEqual([])
      expect(mocks.removePendingNoteSyncItems).toHaveBeenCalledWith('note-1')
      await singleton.destroy()
    })
  })
})

// One store for the whole install, keyed by note id, meant two vaults could
// write the same key — journal notes use deterministic date-based ids such as
// `j2026-08-13`. Sign-out "contained" that by deleting the store outright,
// taking every note's merge history with it. The store is per vault now.
describe('CrdtProvider store scoping', () => {
  const OTHER_VAULT_UUID = '99999999-8888-7777-6666-555555555555'

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.persistenceInstances.length = 0
    mocks.persistenceBehavior.mode = 'ok'
    mocks.preflightResult = { ok: true }
    mocks.preflightQueue.length = 0
    mocks.preflightCalls.length = 0
    mocks.dataDb = {}
    mocks.vaultUuid = VAULT_UUID
    mocks.legacyStoreClaim = undefined
    fs.rmSync(mocks.userDataDir, { recursive: true, force: true })
  })

  afterEach(() => {
    fsHooks.renameSync = null
    fsHooks.cpSync = null
    fs.rmSync(mocks.userDataDir, { recursive: true, force: true })
    resetCrdtProvider()
  })

  it('gives two vaults two different store directories', async () => {
    await new CrdtProvider().initPersistence()

    // A vault switch destroys and replaces the provider, so the next one
    // resolves the path from scratch against the newly opened vault.
    mocks.vaultUuid = OTHER_VAULT_UUID
    await new CrdtProvider().initPersistence()

    expect(mocks.preflightCalls).toEqual([vaultStoreDir(), vaultStoreDir(OTHER_VAULT_UUID)])
  })

  it('gives one vault the same store directory on every launch', async () => {
    await new CrdtProvider().initPersistence()
    await new CrdtProvider().initPersistence()

    // A path that drifted between restarts would orphan the history as
    // thoroughly as deleting it.
    expect(mocks.preflightCalls[0]).toBe(mocks.preflightCalls[1])
    expect(mocks.preflightCalls[0]).toBe(vaultStoreDir())
  })

  it('defers the init until a vault is open, without settling as ready', async () => {
    // #given no vault: app bootstrap, or the vault picker
    mocks.dataDb = null
    const provider = new CrdtProvider()

    await provider.initPersistence()

    // #then nothing is probed or opened — there is no identity to scope to
    expect(mocks.preflightCalls).toEqual([])
    expect(mocks.persistenceInstances).toHaveLength(0)
    // #and the init has NOT settled. A deferral that marked itself ready would
    // pin the provider to in-memory mode for the rest of the session, dropping
    // every note's history on the floor.
    expect(provider.isInitialized()).toBe(false)

    // #when the vault opens and the vault-open path calls it again
    mocks.dataDb = {}
    await provider.initPersistence()

    expect(mocks.preflightCalls).toEqual([vaultStoreDir()])
    expect(provider.isInitialized()).toBe(true)
  })

  it('hands the legacy global store to the first vault that opens, and to no other', async () => {
    // #given the pre-upgrade store, with real history in it
    const legacyDir = `${mocks.userDataDir}/crdt-store`
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(`${legacyDir}/MANIFEST-000001`, 'history')

    // #when the first vault opens after the upgrade
    await new CrdtProvider().initPersistence()

    // #then it inherits the store wholesale — a single-vault user, which is
    // nearly everyone, keeps every note's history and sees no change at all
    expect(fs.existsSync(legacyDir)).toBe(false)
    expect(fs.readFileSync(`${vaultStoreDir()}/MANIFEST-000001`, 'utf8')).toBe('history')
    expect(mocks.legacyStoreClaim).toBe(VAULT_UUID)

    // #and when a second vault opens
    mocks.vaultUuid = OTHER_VAULT_UUID
    await new CrdtProvider().initPersistence()

    // #then it does NOT see that history. The legacy store is keyed by note id
    // with no vault dimension, so handing it to a second vault would replay the
    // first vault's journal entries into it.
    expect(fs.existsSync(`${vaultStoreDir(OTHER_VAULT_UUID)}/MANIFEST-000001`)).toBe(false)
    expect(mocks.legacyStoreClaim).toBe(VAULT_UUID)
  })

  it('records the claim before it moves anything, so a failed move cannot be reassigned', async () => {
    // #given the legacy store and a move that cannot succeed — a full disk, AV
    // holding the directory, or the process dying mid-migration all land here
    const legacyDir = `${mocks.userDataDir}/crdt-store`
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(`${legacyDir}/MANIFEST-000001`, 'history')
    failEveryMove()

    await new CrdtProvider().initPersistence()

    // #then the claim is already on record even though nothing moved. Recording
    // it after the move instead would leave the store unowned in exactly this
    // window, free for the next vault to take.
    expect(mocks.legacyStoreClaim).toBe(VAULT_UUID)
    expect(fs.existsSync(`${legacyDir}/MANIFEST-000001`)).toBe(true)

    // #and a second vault opening into that window still cannot have it
    mocks.vaultUuid = OTHER_VAULT_UUID
    await new CrdtProvider().initPersistence()
    expect(fs.existsSync(`${legacyDir}/MANIFEST-000001`)).toBe(true)
    expect(fs.existsSync(vaultStoreDir(OTHER_VAULT_UUID))).toBe(false)
    expect(mocks.legacyStoreClaim).toBe(VAULT_UUID)
  })

  it('lets the claimant finish a migration that crashed between the claim and the move', async () => {
    // #given a claim recorded but the directory never moved — the app died in
    // the window between the two writes
    const legacyDir = `${mocks.userDataDir}/crdt-store`
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(`${legacyDir}/MANIFEST-000001`, 'history')
    mocks.legacyStoreClaim = VAULT_UUID

    // #when a DIFFERENT vault opens first on the next launch
    mocks.vaultUuid = OTHER_VAULT_UUID
    await new CrdtProvider().initPersistence()

    // #then it must not take the store: the claim is what makes the migration
    // exactly-once, and the crash window is the one place a second claimant
    // could otherwise slip in
    expect(fs.existsSync(`${legacyDir}/MANIFEST-000001`)).toBe(true)
    expect(fs.existsSync(vaultStoreDir(OTHER_VAULT_UUID))).toBe(false)

    // #and when the claimant opens, it resumes and completes the move
    mocks.vaultUuid = VAULT_UUID
    await new CrdtProvider().initPersistence()

    expect(fs.existsSync(legacyDir)).toBe(false)
    expect(fs.readFileSync(`${vaultStoreDir()}/MANIFEST-000001`, 'utf8')).toBe('history')
  })

  it('does not re-apply the legacy store to a claimant that already moved it', async () => {
    // #given the migration completed: claim recorded, store moved, and the
    // claimant has been writing to it since
    const legacyDir = `${mocks.userDataDir}/crdt-store`
    fs.mkdirSync(vaultStoreDir(), { recursive: true })
    fs.writeFileSync(`${vaultStoreDir()}/MANIFEST-000001`, 'moved-then-written-to')
    mocks.legacyStoreClaim = VAULT_UUID
    // A legacy directory that survived because the move fell back to copy and
    // the delete failed.
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(`${legacyDir}/MANIFEST-000001`, 'stale-duplicate')

    await new CrdtProvider().initPersistence()

    // #then the live store is untouched. Merging the leftover back in would
    // replay a second copy of every update the claimant already has.
    expect(fs.readFileSync(`${vaultStoreDir()}/MANIFEST-000001`, 'utf8')).toBe(
      'moved-then-written-to'
    )
  })
})

// Regression suite for the broken classic-level native binding shipped in
// 2026.705.1 on Windows: napi_create_reference failures made every CRDT
// persistence op throw or hang, crashing the editor on first keystroke and
// making note content unloadable. The provider must survive a dead store.
describe('CrdtProvider persistence resilience', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sent = []
    mocks.windows.clear()
    mocks.persistenceInstances.length = 0
    mocks.persistenceBehavior.mode = 'ok'
    mocks.preflightResult = { ok: true }
    mocks.preflightQueue.length = 0
    mocks.preflightCalls.length = 0
    mocks.dataDb = {}
    mocks.vaultUuid = VAULT_UUID
    mocks.legacyStoreClaim = undefined
    mocks.getNoteCacheById.mockReturnValue({
      id: 'note-1',
      path: 'notes/Note.md',
      title: 'Note',
      fileType: 'markdown'
    })
    mocks.safeRead.mockResolvedValue('# Note\n\nBody')
    mocks.parseNote.mockReturnValue({ content: 'Body' })
    mocks.markdownToYFragment.mockImplementation(
      async (_content: string, fragment: Y.XmlFragment) => {
        fragment.insert(0, [new Y.XmlText('Body')])
        return true
      }
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    resetCrdtProvider()
  })

  it('falls back to in-memory mode when the persistence probe rejects', async () => {
    mocks.persistenceBehavior.mode = 'reject'
    const provider = new CrdtProvider()

    await expect(provider.init()).resolves.toBeUndefined()
    expect(provider.isInitialized()).toBe(true)

    // Docs still open and seed from the vault markdown file.
    const doc = await provider.open('note-1')
    expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME).length).toBeGreaterThan(0)

    // Typing must not throw even though the store is dead.
    expect(() => provider.applyIpcUpdate('note-1', makeRemoteUpdate('typed'), 7)).not.toThrow()
    await provider.close('note-1')
  })

  it('never loads the store binding when the preflight child dies', async () => {
    mocks.preflightResult = { ok: false, reason: 'child exited with code 134', stage: 'store' }
    const provider = new CrdtProvider()

    await expect(provider.init()).resolves.toBeUndefined()
    expect(provider.isInitialized()).toBe(true)
    // The whole point: LeveldbPersistence must never be constructed in main
    // when the disposable child crashed exercising the native binding.
    expect(mocks.persistenceInstances).toHaveLength(0)

    const doc = await provider.open('note-1')
    expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME).length).toBeGreaterThan(0)
    await provider.close('note-1')
  })

  // The preflight child probes the REAL crdt-store dir, so it also dies on a
  // store whose on-disk state (torn LDB/MANIFEST from a past crash or full
  // disk) aborts the binding — not just on a binding that is broken outright.
  // The two are told apart empirically, by a control the store cannot be
  // blamed for: probe a directory that is guaranteed empty, BEFORE anything is
  // moved.
  describe('store quarantine', () => {
    const userDataDir = mocks.userDataDir
    const storeDir = vaultStoreDir()
    const storeRoot = `${userDataDir}/crdt-stores`
    /** Quarantine dirs sit next to the store they were moved aside from. */
    const quarantinedDirs = (): string[] =>
      fs.readdirSync(storeRoot).filter((f) => f.startsWith(`${VAULT_UUID}.broken-`))

    beforeEach(() => {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    })

    afterEach(() => {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    })

    it('quarantines a corrupt store and continues on a fresh one when the control passes', async () => {
      fs.mkdirSync(storeDir, { recursive: true })
      fs.writeFileSync(`${storeDir}/MANIFEST-000001`, 'torn')
      mocks.preflightQueue.push(
        { ok: false, reason: 'child exited with code 134', stage: 'store' },
        { ok: true }
      )

      const provider = new CrdtProvider()
      await expect(provider.init()).resolves.toBeUndefined()

      // Corrupt store moved aside (preserved, not deleted), fresh store adopted.
      expect(mocks.preflightCalls).toEqual([storeDir, `${storeDir}.probe`])
      expect(fs.existsSync(storeDir)).toBe(false)
      const quarantined = quarantinedDirs()
      expect(quarantined).toHaveLength(1)
      expect(fs.existsSync(`${storeRoot}/${quarantined[0]}/MANIFEST-000001`)).toBe(true)
      expect(mocks.persistenceInstances).toHaveLength(1)
      // The control directory does not outlive the probe.
      expect(fs.existsSync(`${storeDir}.probe`)).toBe(false)
    })

    // Issue #1583: on 19/19 win32 installs the binding access-violated against
    // an empty directory as readily as against the user's data, and the store
    // was moved aside, rm'd and moved back for it — every launch, forever.
    it('never moves the store when the empty control directory fails too', async () => {
      fs.mkdirSync(storeDir, { recursive: true })
      fs.writeFileSync(`${storeDir}/MANIFEST-000001`, 'healthy-but-binding-broken')
      mocks.preflightQueue.push(
        { ok: false, reason: 'child exited with code 134', stage: 'store' },
        { ok: false, reason: 'child exited with code 134', stage: 'store' }
      )

      const provider = new CrdtProvider()
      await expect(provider.init()).resolves.toBeUndefined()

      // The binding is the problem, not the data — so the user's CRDT history
      // is never touched at all, rather than moved aside and moved back.
      expect(mocks.preflightCalls).toEqual([storeDir, `${storeDir}.probe`])
      expect(fs.existsSync(`${storeDir}/MANIFEST-000001`)).toBe(true)
      expect(quarantinedDirs()).toHaveLength(0)
      expect(fs.existsSync(`${storeDir}.probe`)).toBe(false)
      expect(mocks.persistenceInstances).toHaveLength(0)
      expect(provider.isInitialized()).toBe(true)
    })

    // Production (9 Windows installs, v717.2 → v719.2): the preflight child
    // died in Chromium/crashpad init (0xFFFF7003) before it ever opened the
    // store, and the store got quarantined for it — every launch, with the
    // restore then failing EPERM. A child that never reached the store cannot
    // be evidence against it.
    it('does not quarantine when the child never started', async () => {
      fs.mkdirSync(storeDir, { recursive: true })
      fs.writeFileSync(`${storeDir}/MANIFEST-000001`, 'healthy')
      mocks.preflightQueue.push({
        ok: false,
        reason: 'child exited with code -36861 (0xFFFF7003)',
        stage: 'bootstrap'
      })

      const provider = new CrdtProvider()
      await expect(provider.init()).resolves.toBeUndefined()

      expect(mocks.preflightCalls).toEqual([storeDir])
      expect(fs.existsSync(`${storeDir}/MANIFEST-000001`)).toBe(true)
      expect(quarantinedDirs()).toHaveLength(0)
      expect(mocks.persistenceInstances).toHaveLength(0)
      expect(provider.isInitialized()).toBe(true)
    })

    it('does not quarantine when the child died loading the binding', async () => {
      fs.mkdirSync(storeDir, { recursive: true })
      fs.writeFileSync(`${storeDir}/MANIFEST-000001`, 'healthy')
      mocks.preflightQueue.push({
        ok: false,
        reason: 'child exited with code 1',
        stage: 'binding'
      })

      const provider = new CrdtProvider()
      await expect(provider.init()).resolves.toBeUndefined()

      expect(mocks.preflightCalls).toEqual([storeDir])
      expect(fs.existsSync(`${storeDir}/MANIFEST-000001`)).toBe(true)
      expect(quarantinedDirs()).toHaveLength(0)
    })

    // The failed re-probe leaves a partial fresh store behind; renaming the
    // quarantine back onto an existing directory is EPERM on Windows, which is
    // how installs ended up with their history stranded in `.broken-*`.
    it('restores the quarantined store over a partial fresh store', async () => {
      fs.mkdirSync(storeDir, { recursive: true })
      fs.writeFileSync(`${storeDir}/MANIFEST-000001`, 'healthy-but-binding-broken')
      mocks.preflightQueue.push(
        { ok: false, reason: 'child exited with code 134', stage: 'store' },
        {
          ok: false,
          reason: 'child exited with code 134',
          stage: 'store',
          // The re-probe child created the fresh dir before dying.
          onCall: () => fs.mkdirSync(`${storeDir}/LOCK`, { recursive: true })
        }
      )

      const provider = new CrdtProvider()
      await expect(provider.init()).resolves.toBeUndefined()

      expect(fs.readFileSync(`${storeDir}/MANIFEST-000001`, 'utf8')).toBe(
        'healthy-but-binding-broken'
      )
      expect(quarantinedDirs()).toHaveLength(0)
    })

    it('restores by copy when the rename keeps failing', async () => {
      fs.mkdirSync(storeDir, { recursive: true })
      fs.writeFileSync(`${storeDir}/MANIFEST-000001`, 'healthy-but-binding-broken')
      mocks.preflightQueue.push(
        { ok: false, reason: 'child exited with code 134', stage: 'store' },
        { ok: false, reason: 'child exited with code 134', stage: 'store' }
      )

      // Windows: AV or the just-exited child still holds the directory, so
      // every rename after the quarantine fails.
      let quarantined = false
      fsHooks.renameSync = (from, to) => {
        if (!quarantined) {
          quarantined = true
          fsHooks.realRenameSync(from, to)
          return
        }
        const err = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      }

      try {
        const provider = new CrdtProvider()
        await expect(provider.init()).resolves.toBeUndefined()
      } finally {
        fsHooks.renameSync = null
      }

      // History is back where the next launch will look for it, not stranded.
      expect(fs.readFileSync(`${storeDir}/MANIFEST-000001`, 'utf8')).toBe(
        'healthy-but-binding-broken'
      )
      expect(quarantinedDirs()).toHaveLength(0)
    })

    it('does not re-probe when no store exists to quarantine', async () => {
      mocks.preflightQueue.push({ ok: false, reason: 'child exited with code 134', stage: 'store' })

      const provider = new CrdtProvider()
      await expect(provider.init()).resolves.toBeUndefined()

      expect(mocks.preflightCalls).toEqual([storeDir])
      expect(mocks.persistenceInstances).toHaveLength(0)
      expect(provider.isInitialized()).toBe(true)
    })
  })

  it('falls back to in-memory mode when the persistence probe hangs', async () => {
    vi.useFakeTimers()
    mocks.persistenceBehavior.mode = 'hang'
    const provider = new CrdtProvider()

    const init = provider.init()
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(init).resolves.toBeUndefined()

    expect(provider.isInitialized()).toBe(true)
  })

  it('does not retry a failed probe on subsequent init calls', async () => {
    mocks.persistenceBehavior.mode = 'reject'
    const provider = new CrdtProvider()

    await provider.initPersistence()
    await provider.initPersistence()
    await provider.init()

    expect(mocks.persistenceInstances).toHaveLength(1)
  })

  it('opens a doc from markdown when loading the persisted doc fails mid-session', async () => {
    const provider = new CrdtProvider()
    await provider.init()
    expect(provider.isInitialized()).toBe(true)

    mocks.persistenceBehavior.mode = 'reject'
    const doc = await provider.open('note-1')
    expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME).length).toBeGreaterThan(0)
    await provider.close('note-1')
  })

  it('reports uninitialized again after destroy', async () => {
    const provider = new CrdtProvider()
    await provider.init()
    expect(provider.isInitialized()).toBe(true)

    await provider.destroy()
    expect(provider.isInitialized()).toBe(false)
  })
})

describe('CrdtProvider bootstrap doc-capacity raise', () => {
  let provider: CrdtProvider
  let queue: { enqueue: ReturnType<typeof vi.fn>; dropNote: ReturnType<typeof vi.fn> }
  let pushSnapshot: ReturnType<typeof vi.fn<SnapshotPushFn>>

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.sent = []
    mocks.windows.clear()
    mocks.persistenceInstances.length = 0
    mocks.persistenceBehavior.mode = 'ok'
    mocks.preflightResult = { ok: true }
    mocks.preflightQueue.length = 0
    mocks.preflightCalls.length = 0
    mocks.dataDb = {}
    mocks.vaultUuid = VAULT_UUID
    mocks.getNoteCacheById.mockImplementation((id: string) => ({
      id,
      path: `notes/${id}.md`,
      title: id,
      fileType: 'markdown'
    }))
    mocks.toAbsolutePath.mockImplementation((p: string) => `/vault/${p}`)
    mocks.safeRead.mockResolvedValue('# Note\n\nBody')
    mocks.parseNote.mockReturnValue({ content: 'Body' })
    mocks.markdownToYFragment.mockImplementation(
      async (_content: string, fragment: Y.XmlFragment) => {
        fragment.insert(0, [new Y.XmlText('Body')])
        return true
      }
    )
    mocks.compactYDoc.mockReturnValue(null)
    queue = { enqueue: vi.fn(), dropNote: vi.fn() }
    pushSnapshot = vi.fn<SnapshotPushFn>().mockResolvedValue(undefined)
    // Steady state of 2, the smallest size that can prove a raise above it.
    provider = new CrdtProvider({ inactiveDocLimit: 2 })
    await provider.init(queue as any, pushSnapshot)
  })

  afterEach(() => {
    resetCrdtProvider()
  })

  const openSyncDocs = async (count: number): Promise<string[]> => {
    const ids = Array.from({ length: count }, (_, i) => `note-${i + 1}`)
    for (const id of ids) await provider.open(id)
    return ids
  }

  it('raises capacity during bootstrap and evicts back to steady-state on restore', async () => {
    expect(provider.inactiveDocCapacity).toBe(2)

    const restore = provider.raiseInactiveDocCapacity(4)
    expect(provider.inactiveDocCapacity).toBe(4)

    // A whole bootstrap sub-chunk fits without splitting at the old limit.
    await openSyncDocs(4)
    for (const id of ['note-1', 'note-2', 'note-3', 'note-4']) {
      expect(provider.getDoc(id)).toBeDefined()
    }

    // The revert sheds back down through the ordinary close/flush path.
    await restore()
    expect(provider.inactiveDocCapacity).toBe(2)
    expect(provider.getDoc('note-1')).toBeUndefined()
    expect(provider.getDoc('note-2')).toBeUndefined()
    expect(provider.getDoc('note-3')).toBeDefined()
    expect(provider.getDoc('note-4')).toBeDefined()

    // Idempotent: a second call must not re-close anything or throw.
    await restore()
    expect(provider.getDoc('note-4')).toBeDefined()
  })

  it('never lowers capacity below the raise already in force', () => {
    const restoreOne = provider.raiseInactiveDocCapacity(5)
    const restoreTwo = provider.raiseInactiveDocCapacity(3)

    expect(provider.inactiveDocCapacity).toBe(5)

    return restoreOne().then(restoreTwo)
  })

  it('refuses a raise below the steady-state limit', () => {
    const restore = provider.raiseInactiveDocCapacity(1)
    expect(provider.inactiveDocCapacity).toBe(2)
    return restore()
  })

  it('defaults to the steady-state 32-doc limit when no override is configured', () => {
    expect(new CrdtProvider().inactiveDocCapacity).toBe(32)
  })
})

/**
 * Batched snapshot pushes.
 *
 * The bookkeeping `pushSnapshotForNote` owns — the three skips, zeroing the
 * counters before the send, restoring them after a failure, closing a doc
 * nothing else had open — is now shared with a path that sends 50 notes in one
 * request. These pin that none of it was left behind in the split.
 */
describe('CrdtProvider batched snapshot pushes', () => {
  let provider: CrdtProvider
  let queue: { enqueue: ReturnType<typeof vi.fn>; dropNote: ReturnType<typeof vi.fn> }
  let pushSnapshot: ReturnType<typeof vi.fn<SnapshotPushFn>>
  let pushBatch: ReturnType<typeof vi.fn>
  /** noteId -> accepted. Anything absent is accepted, like a healthy server. */
  let rejected: Set<string>

  const markdownRow = (id: string): Record<string, unknown> => ({
    id,
    path: `notes/${id}.md`,
    title: id,
    fileType: 'markdown'
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.sent = []
    mocks.windows.clear()
    mocks.persistenceInstances.length = 0
    mocks.persistenceBehavior.mode = 'ok'
    mocks.preflightResult = { ok: true }
    mocks.preflightQueue.length = 0
    mocks.dataDb = {}
    mocks.vaultUuid = VAULT_UUID
    mocks.getNoteCacheById.mockImplementation((_db: unknown, id: string) => markdownRow(id))
    mocks.toAbsolutePath.mockImplementation((p: string) => `/vault/${p}`)
    mocks.safeRead.mockResolvedValue('# Note\n\nBody')
    mocks.parseNote.mockReturnValue({ content: 'Body' })
    mocks.markdownToYFragment.mockImplementation(
      async (_content: string, fragment: Y.XmlFragment) => {
        fragment.insert(0, [new Y.XmlText('Body')])
        return true
      }
    )
    mocks.compactYDoc.mockReturnValue(null)

    queue = { enqueue: vi.fn(), dropNote: vi.fn() }
    pushSnapshot = vi.fn<SnapshotPushFn>().mockResolvedValue(undefined)
    rejected = new Set<string>()
    pushBatch = vi.fn(async (entries: Array<{ noteId: string }>) => {
      return new Map(entries.map((e) => [e.noteId, !rejected.has(e.noteId)]))
    })

    provider = new CrdtProvider()
    await provider.init(queue as any, pushSnapshot, pushBatch as any)
  })

  afterEach(() => {
    resetCrdtProvider()
  })

  it('splits into requests at the server cap instead of one request per note', async () => {
    // #given a seeded vault's worth of bodies. One request per note was
    // ~750ms each, so 100 notes cost 15 seconds.
    const noteIds = Array.from({ length: 120 }, (_, i) => `note-${i}`)

    // #when
    const results = await provider.pushSnapshotsForNotes(noteIds, { concurrency: 4 })

    // #then 50 + 50 + 20, and the single-note endpoint is never touched.
    const sizes = pushBatch.mock.calls.map((call) => (call[0] as unknown[]).length)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(120)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(50)
    expect(pushBatch).toHaveBeenCalledTimes(3)
    expect(pushSnapshot).not.toHaveBeenCalled()
    expect(results.size).toBe(120)
    expect([...results.values()].every(Boolean)).toBe(true)
  })

  it('prepares a repeated id once, because the endpoint rejects a duplicated note', async () => {
    // #given the same note named twice. Preparing it twice would also zero its
    // counters twice and lose the debt the second restore had nothing to put
    // back.
    const results = await provider.pushSnapshotsForNotes(['note-1', 'note-1'])

    const batched = pushBatch.mock.calls[0][0] as Array<{ noteId: string }>
    expect(batched.map((e) => e.noteId)).toEqual(['note-1'])
    expect(results.size).toBe(1)
  })

  it('still refuses binary, local-only and empty notes before they reach the wire', async () => {
    // #given one of each refusal the single-note path documents
    mocks.getNoteCacheById.mockImplementation((_db: unknown, id: string) => {
      if (id === 'pdf-note') return { id, path: 'notes/File.pdf', fileType: 'pdf' }
      if (id === 'private-note') return { ...markdownRow(id), localOnly: true }
      return markdownRow(id)
    })
    // An empty file seeds nothing, so the doc has no state worth pushing.
    mocks.safeRead.mockImplementation(async (p: string) =>
      p === '/vault/notes/empty-note.md' ? '' : '# Note\n\nBody'
    )

    // #when
    const results = await provider.pushSnapshotsForNotes([
      'note-ok',
      'pdf-note',
      'private-note',
      'empty-note'
    ])

    // #then only the real markdown note is sent, and the other three read as
    // "not pushed" rather than as silent successes.
    const batched = pushBatch.mock.calls[0][0] as Array<{ noteId: string }>
    expect(batched.map((e) => e.noteId)).toEqual(['note-ok'])
    expect(results.get('pdf-note')).toBe(false)
    expect(results.get('private-note')).toBe(false)
    expect(results.get('empty-note')).toBe(false)
    expect(results.get('note-ok')).toBe(true)
  })

  it('leaves a note the server rejected inside the batch pending and retryable', async () => {
    // #given two notes with unpushed local edits, one of which the server will
    // refuse. A 200 with `accepted: false` is the case that used to have no
    // representation at all.
    await provider.open('note-a', 1)
    await provider.open('note-b', 1)
    provider.updateMeta('note-a', { title: 'edited a' })
    provider.updateMeta('note-b', { title: 'edited b' })
    rejected.add('note-b')

    // #when
    const results = await provider.pushSnapshotsForNotes(['note-a', 'note-b'])

    // #then
    expect(results.get('note-a')).toBe(true)
    expect(results.get('note-b')).toBe(false)

    // #and the debt is the thing that makes it retryable: the accepted note
    // owes nothing, the rejected one owes exactly what it owed before.
    const metrics = new Map(
      provider.getDocSizeMetrics().map((m) => [m.noteId, m.pendingSnapshotBytes])
    )
    expect(metrics.get('note-a')).toBe(0)
    expect(metrics.get('note-b')).toBeGreaterThan(0)

    // #and the existing retry paths pick it up unchanged.
    await expect(provider.pushAllSnapshots()).resolves.toBe(1)
    expect(pushSnapshot).toHaveBeenCalledTimes(1)
    expect(pushSnapshot.mock.calls[0][0]).toBe('note-b')
  })

  it('closes the docs it opened itself and leaves the ones it did not', async () => {
    // #given one note already open in an editor and one that is not
    await provider.open('note-open', 3)

    // #when
    await provider.pushSnapshotsForNotes(['note-open', 'note-closed'])

    // #then the editor's doc survives the push; the borrowed one does not.
    expect(provider.getDoc('note-open')).toBeDefined()
    expect(provider.getDoc('note-closed')).toBeUndefined()
  })

  it('falls back to one push per note when no batch fn is wired', async () => {
    // #given a provider with only the single-note push — every caller that
    // never wires a batch fn, which is most of them.
    const single = new CrdtProvider()
    const singlePush = vi.fn<SnapshotPushFn>().mockResolvedValue(undefined)
    await single.init(queue as any, singlePush)

    // #when
    const results = await single.pushSnapshotsForNotes(['note-a', 'note-b'], { concurrency: 2 })

    // #then
    expect(singlePush.mock.calls.map((c) => c[0]).sort()).toEqual(['note-a', 'note-b'])
    expect(results.get('note-a')).toBe(true)
    expect(results.get('note-b')).toBe(true)
    await single.destroy()
  })
})
