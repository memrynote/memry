import * as Y from 'yjs'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CrdtPreflightStage } from './crdt-preflight-protocol'

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
  realRenameSync: (from: string, to: string): void => {
    throw new Error(`fs mock not installed (${from} -> ${to})`)
  }
}))

vi.mock('fs', async (importActual) => {
  const actual = await importActual<typeof import('fs')>()
  fsHooks.realRenameSync = actual.renameSync
  const renameSync = (from: string, to: string): void =>
    (fsHooks.renameSync ?? actual.renameSync)(from, to)
  return { ...actual, default: { ...actual, renameSync }, renameSync }
})

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
    safeRead: vi.fn(),
    parseNote: vi.fn(),
    markdownToYFragment: vi.fn(),
    repairEmptyBlockIds: vi.fn(() => 0),
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
  getIndexDatabase: () => ({ kind: 'index-db' })
}))

vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: (...args: unknown[]) => mocks.getNoteCacheById(...args)
}))

vi.mock('../vault/notes', () => ({
  toAbsolutePath: (path: string) => `/vault/${path}`
}))

vi.mock('../vault/file-ops', () => ({
  safeRead: (...args: unknown[]) => mocks.safeRead(...args)
}))

vi.mock('../vault/frontmatter', () => ({
  parseNote: (...args: unknown[]) => mocks.parseNote(...args),
  serializeNote: vi.fn(),
  serializeParsedNote: vi.fn()
}))

vi.mock('./blocknote-converter', () => ({
  markdownToYFragment: (...args: unknown[]) => mocks.markdownToYFragment(...args),
  repairEmptyBlockIds: (...args: unknown[]) => mocks.repairEmptyBlockIds(...args)
}))

vi.mock('./crdt-compact-utils', () => ({
  compactYDoc: (...args: unknown[]) => mocks.compactYDoc(...args)
}))

vi.mock('./crdt-writeback', () => ({
  scheduleWriteback: (...args: unknown[]) => mocks.scheduleWriteback(...args),
  flushPendingWritebacks: (...args: unknown[]) => mocks.flushPendingWritebacks(...args),
  recordNetworkUpdate: (...args: unknown[]) => mocks.recordNetworkUpdate(...args),
  resetWritebackState: (...args: unknown[]) => mocks.resetWritebackState(...args)
}))

vi.mock('./microtask-batch-broadcaster', () => ({
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
import { CrdtProvider, getCrdtProvider, resetCrdtProvider } from './crdt-provider'

mocks.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-crdt-'))

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
  let queue: { enqueue: ReturnType<typeof vi.fn> }
  let pushSnapshot: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.sent = []
    mocks.windows.clear()
    mocks.persistenceInstances.length = 0
    mocks.persistenceBehavior.mode = 'ok'
    mocks.preflightResult = { ok: true }
    mocks.preflightQueue.length = 0
    mocks.preflightCalls.length = 0
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
    mocks.compactYDoc.mockReturnValue(null)
    queue = { enqueue: vi.fn() }
    pushSnapshot = vi.fn().mockResolvedValue(undefined)
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

  it('covers provider singleton, idempotent init, and wipe storage lifecycle', async () => {
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

    await provider.wipeStorage()
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
  // The two are told apart empirically: quarantine the store, re-probe fresh.
  describe('store quarantine', () => {
    const userDataDir = mocks.userDataDir
    const storeDir = `${userDataDir}/crdt-store`

    beforeEach(() => {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    })

    afterEach(() => {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    })

    it('quarantines a corrupt store and continues on a fresh one when the re-probe passes', async () => {
      fs.mkdirSync(storeDir, { recursive: true })
      fs.writeFileSync(`${storeDir}/MANIFEST-000001`, 'torn')
      mocks.preflightQueue.push(
        { ok: false, reason: 'child exited with code 134', stage: 'store' },
        { ok: true }
      )

      const provider = new CrdtProvider()
      await expect(provider.init()).resolves.toBeUndefined()

      // Corrupt store moved aside (preserved, not deleted), fresh store adopted.
      expect(mocks.preflightCalls).toEqual([storeDir, storeDir])
      expect(fs.existsSync(storeDir)).toBe(false)
      const quarantined = fs
        .readdirSync(userDataDir)
        .filter((f) => f.startsWith('crdt-store.broken-'))
      expect(quarantined).toHaveLength(1)
      expect(fs.existsSync(`${userDataDir}/${quarantined[0]}/MANIFEST-000001`)).toBe(true)
      expect(mocks.persistenceInstances).toHaveLength(1)
    })

    it('restores the quarantined store when the re-probe also fails (broken binding)', async () => {
      fs.mkdirSync(storeDir, { recursive: true })
      fs.writeFileSync(`${storeDir}/MANIFEST-000001`, 'healthy-but-binding-broken')
      mocks.preflightQueue.push(
        { ok: false, reason: 'child exited with code 134', stage: 'store' },
        { ok: false, reason: 'child exited with code 134', stage: 'store' }
      )

      const provider = new CrdtProvider()
      await expect(provider.init()).resolves.toBeUndefined()

      // Binding is the problem, not the data: put the store back so a future
      // launch with a working binding finds the user's CRDT history intact.
      expect(mocks.preflightCalls).toEqual([storeDir, storeDir])
      expect(fs.existsSync(`${storeDir}/MANIFEST-000001`)).toBe(true)
      expect(
        fs.readdirSync(userDataDir).filter((f) => f.startsWith('crdt-store.broken-'))
      ).toHaveLength(0)
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
      expect(
        fs.readdirSync(userDataDir).filter((f) => f.startsWith('crdt-store.broken-'))
      ).toHaveLength(0)
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
      expect(
        fs.readdirSync(userDataDir).filter((f) => f.startsWith('crdt-store.broken-'))
      ).toHaveLength(0)
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
      expect(
        fs.readdirSync(userDataDir).filter((f) => f.startsWith('crdt-store.broken-'))
      ).toHaveLength(0)
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
      expect(
        fs.readdirSync(userDataDir).filter((f) => f.startsWith('crdt-store.broken-'))
      ).toHaveLength(0)
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
