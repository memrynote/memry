import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sent: [] as Array<{ windowId: number; channel: string; payload: unknown }>,
  windows: new Map<
    number,
    { isDestroyed: ReturnType<typeof vi.fn>; webContents: { send: ReturnType<typeof vi.fn> } }
  >(),
  getNoteCacheById: vi.fn(),
  safeRead: vi.fn(),
  parseNote: vi.fn(),
  markdownToYFragment: vi.fn(),
  compactYDoc: vi.fn(),
  scheduleWriteback: vi.fn(),
  flushPendingWritebacks: vi.fn(),
  recordNetworkUpdate: vi.fn(),
  persistenceInstances: [] as Array<{
    getYDoc: ReturnType<typeof vi.fn>
    clearDocument: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    storeUpdate: ReturnType<typeof vi.fn>
    flushDocument: ReturnType<typeof vi.fn>
  }>
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/memry-crdt-test' },
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

vi.mock('y-leveldb', () => ({
  LeveldbPersistence: class {
    getYDoc = vi.fn(async (noteId: string) => new Y.Doc({ guid: `${noteId}:persisted` }))
    clearDocument = vi.fn(async () => {})
    destroy = vi.fn(async () => {})
    storeUpdate = vi.fn(async () => {})
    flushDocument = vi.fn(async () => {})

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
  parseNote: (...args: unknown[]) => mocks.parseNote(...args)
}))

vi.mock('./blocknote-converter', () => ({
  markdownToYFragment: (...args: unknown[]) => mocks.markdownToYFragment(...args)
}))

vi.mock('./crdt-compact-utils', () => ({
  compactYDoc: (...args: unknown[]) => mocks.compactYDoc(...args)
}))

vi.mock('./crdt-writeback', () => ({
  scheduleWriteback: (...args: unknown[]) => mocks.scheduleWriteback(...args),
  flushPendingWritebacks: (...args: unknown[]) => mocks.flushPendingWritebacks(...args),
  recordNetworkUpdate: (...args: unknown[]) => mocks.recordNetworkUpdate(...args)
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

const makeRemoteUpdate = (text: string): number[] => {
  const doc = new Y.Doc()
  doc.getMap('meta').set('title', text)
  return Array.from(Y.encodeStateAsUpdate(doc))
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
