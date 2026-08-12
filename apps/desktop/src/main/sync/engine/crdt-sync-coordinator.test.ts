import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncContext } from './sync-context'
import { CrdtSyncCoordinator } from './crdt-sync-coordinator'

const fetchCrdtSnapshotMock = vi.fn()
const getFromServerMock = vi.fn()
const postToServerMock = vi.fn()
const decryptCrdtUpdateMock = vi.fn()
const secureCleanupMock = vi.fn()

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../http-client', () => ({
  fetchCrdtSnapshot: (...args: unknown[]) => fetchCrdtSnapshotMock(...args),
  getFromServer: (...args: unknown[]) => getFromServerMock(...args),
  postToServer: (...args: unknown[]) => postToServerMock(...args)
}))

vi.mock('../../crypto/index', () => ({
  secureCleanup: (...args: unknown[]) => secureCleanupMock(...args)
}))

const withRetryMock = vi.fn(async (fn: () => Promise<unknown>) => ({ value: await fn() }))

vi.mock('../retry', () => ({
  withRetry: (fn: () => Promise<unknown>, options?: unknown) => withRetryMock(fn, options)
}))

vi.mock('../crdt-encrypt', () => ({
  decryptCrdtUpdate: (...args: unknown[]) => decryptCrdtUpdateMock(...args)
}))

describe('CrdtSyncCoordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchCrdtSnapshotMock.mockResolvedValue(null)
  })

  it('tracks and drains pending CRDT pulls', () => {
    const coordinator = new CrdtSyncCoordinator({ deps: {} } as unknown as SyncContext, vi.fn())

    coordinator.addPendingPull('note-1')
    coordinator.addPendingPull('note-2')
    coordinator.addPendingPull('note-1')

    expect(coordinator.pendingPullCount).toBe(2)
    expect(coordinator.drainPendingPulls()).toEqual(['note-1', 'note-2'])
    expect(coordinator.pendingPullCount).toBe(0)
  })

  it('applies single-note incrementals, skips unknown signers, and seeds empty local docs', async () => {
    const applyRemoteUpdate = vi.fn()
    const open = vi.fn().mockResolvedValue({})
    const closeIfInactive = vi.fn().mockResolvedValue(true)
    const getDoc = vi.fn().mockReturnValue(undefined)
    const getStateVector = vi.fn().mockReturnValue(new Uint8Array([1, 2]))
    const seedFromMarkdownPublic = vi.fn()

    getFromServerMock.mockResolvedValue({
      updates: [
        {
          sequenceNum: 4,
          data: 'eA==',
          createdAt: 1,
          signerDeviceId: 'missing-device'
        },
        {
          sequenceNum: 5,
          data: 'eQ==',
          createdAt: 2,
          signerDeviceId: 'device-a'
        }
      ],
      hasMore: false
    })
    decryptCrdtUpdateMock.mockReturnValue(new Uint8Array([7, 7, 7]))

    const ctx = {
      deps: {
        crdtProvider: {
          getDoc,
          open,
          closeIfInactive,
          applyRemoteUpdate,
          getStateVector,
          seedFromMarkdownPublic
        }
      },
      abortController: new AbortController()
    } as unknown as SyncContext

    const resolveDeviceKey = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new Uint8Array([1, 2, 3]))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new Uint8Array([1, 2, 3]))
    const coordinator = new CrdtSyncCoordinator(ctx, resolveDeviceKey)

    await coordinator.applyCrdtIncrementals('note-1', 'token-1', new Uint8Array([4, 5, 6]))

    expect(open).toHaveBeenCalledWith('note-1', undefined, { skipSeed: true })
    expect(closeIfInactive).toHaveBeenCalledWith('note-1')
    expect(getFromServerMock).toHaveBeenCalledWith(
      '/sync/crdt/updates?note_id=note-1&since=0&limit=100',
      'token-1'
    )
    expect(applyRemoteUpdate).toHaveBeenCalledWith('note-1', new Uint8Array([7, 7, 7]))
    expect(seedFromMarkdownPublic).toHaveBeenCalledWith('note-1')
  })

  it('does not close single-note incrementals that were already open', async () => {
    const openDoc = {}
    const open = vi.fn().mockResolvedValue(openDoc)
    const closeIfInactive = vi.fn()

    getFromServerMock.mockResolvedValue({
      updates: [],
      hasMore: false
    })

    const ctx = {
      deps: {
        crdtProvider: {
          getDoc: vi.fn().mockReturnValue(openDoc),
          open,
          closeIfInactive,
          applyRemoteUpdate: vi.fn(),
          getStateVector: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
          seedFromMarkdownPublic: vi.fn()
        }
      },
      abortController: new AbortController()
    } as unknown as SyncContext

    const coordinator = new CrdtSyncCoordinator(
      ctx,
      vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]))
    )

    await coordinator.applyCrdtIncrementals('note-1', 'token-1', new Uint8Array([4, 5, 6]))

    expect(open).toHaveBeenCalledWith('note-1', undefined, { skipSeed: true })
    expect(closeIfInactive).not.toHaveBeenCalled()
  })

  it('pullCrdtForNote exits without credentials and cleans up the vault key after pulls', async () => {
    const applyCrdtIncrementals = vi.spyOn(CrdtSyncCoordinator.prototype, 'applyCrdtIncrementals')
    applyCrdtIncrementals.mockResolvedValue(undefined)

    const ctx = {
      deps: {
        getAccessToken: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce('token-1')
          .mockResolvedValueOnce('token-1'),
        getVaultKey: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(new Uint8Array([9])),
        crdtProvider: {}
      }
    } as unknown as SyncContext
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    await coordinator.pullCrdtForNote('note-no-token')
    await coordinator.pullCrdtForNote('note-no-key')
    await coordinator.pullCrdtForNote('note-ok')

    expect(applyCrdtIncrementals).toHaveBeenCalledTimes(1)
    expect(applyCrdtIncrementals).toHaveBeenCalledWith(
      'note-ok',
      'token-1',
      new Uint8Array([9]),
      expect.any(AbortSignal)
    )
    expect(secureCleanupMock).toHaveBeenCalledWith(new Uint8Array([9]))

    applyCrdtIncrementals.mockRestore()
  })

  it('uses the latest server snapshot as the batch baseline even when the local doc is non-empty', async () => {
    const applyRemoteUpdate = vi.fn()
    const open = vi.fn().mockResolvedValue({})
    const closeIfInactive = vi.fn().mockResolvedValue(true)
    const getStateVector = vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4]))

    fetchCrdtSnapshotMock.mockResolvedValue({
      snapshot: new Uint8Array([9, 9, 9]),
      sequenceNum: 36,
      signerDeviceId: 'device-a'
    })
    postToServerMock.mockResolvedValue({
      notes: {
        'note-1': {
          updates: [],
          hasMore: false
        }
      }
    })
    decryptCrdtUpdateMock.mockReturnValue(new Uint8Array([7, 7, 7]))

    const ctx = {
      deps: {
        crdtProvider: {
          getDoc: vi.fn().mockReturnValue(undefined),
          open,
          closeIfInactive,
          applyRemoteUpdate,
          getStateVector,
          seedFromMarkdownPublic: vi.fn()
        }
      },
      abortController: new AbortController()
    } as unknown as SyncContext

    const resolveDeviceKey = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]))
    const coordinator = new CrdtSyncCoordinator(ctx, resolveDeviceKey)

    await coordinator.applyCrdtBatch(['note-1'], 'token-1', new Uint8Array([4, 5, 6]))

    expect(fetchCrdtSnapshotMock).toHaveBeenCalledWith('note-1', 'token-1')
    expect(resolveDeviceKey).toHaveBeenCalledWith('device-a')
    expect(applyRemoteUpdate).toHaveBeenCalledWith('note-1', new Uint8Array([7, 7, 7]))
    expect(postToServerMock).toHaveBeenCalledWith(
      '/sync/crdt/updates/batch',
      {
        notes: [{ noteId: 'note-1', since: 36 }],
        limit: 100
      },
      'token-1'
    )
    expect(closeIfInactive).toHaveBeenCalledWith('note-1')
  })

  it('closes only batch docs opened by sync and leaves already-open docs alone', async () => {
    const openDoc = {}
    const getDoc = vi.fn().mockReturnValueOnce(undefined).mockReturnValueOnce(openDoc)
    const closeIfInactive = vi.fn().mockResolvedValue(true)

    postToServerMock.mockResolvedValue({
      notes: {
        'sync-only-note': {
          updates: [],
          hasMore: false
        },
        'active-note': {
          updates: [],
          hasMore: false
        }
      }
    })

    const ctx = {
      deps: {
        crdtProvider: {
          getDoc,
          open: vi.fn().mockResolvedValue({}),
          closeIfInactive,
          applyRemoteUpdate: vi.fn(),
          getStateVector: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
          seedFromMarkdownPublic: vi.fn()
        }
      },
      abortController: new AbortController()
    } as unknown as SyncContext

    const coordinator = new CrdtSyncCoordinator(
      ctx,
      vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]))
    )

    await coordinator.applyCrdtBatch(
      ['sync-only-note', 'active-note'],
      'token-1',
      new Uint8Array([4, 5, 6])
    )

    expect(closeIfInactive).toHaveBeenCalledTimes(1)
    expect(closeIfInactive).toHaveBeenCalledWith('sync-only-note')
  })

  it('reuses the highest applied CRDT sequence as the next batch baseline', async () => {
    const applyRemoteUpdate = vi.fn()
    const open = vi.fn().mockResolvedValue({})
    const getStateVector = vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4]))

    fetchCrdtSnapshotMock.mockResolvedValue({
      snapshot: new Uint8Array([9, 9, 9]),
      sequenceNum: 2,
      signerDeviceId: 'device-a'
    })
    postToServerMock
      .mockResolvedValueOnce({
        notes: {
          'note-1': {
            updates: [
              {
                sequenceNum: 5,
                data: 'eA==',
                createdAt: 1,
                signerDeviceId: 'device-a'
              },
              {
                sequenceNum: 6,
                data: 'eQ==',
                createdAt: 2,
                signerDeviceId: 'device-a'
              }
            ],
            hasMore: false
          }
        }
      })
      .mockResolvedValueOnce({
        notes: {
          'note-1': {
            updates: [],
            hasMore: false
          }
        }
      })
    decryptCrdtUpdateMock.mockReturnValue(new Uint8Array([7, 7, 7]))

    const ctx = {
      deps: {
        crdtProvider: {
          getDoc: vi.fn().mockReturnValue(undefined),
          open,
          closeIfInactive: vi.fn().mockResolvedValue(true),
          applyRemoteUpdate,
          getStateVector,
          seedFromMarkdownPublic: vi.fn()
        }
      },
      abortController: new AbortController()
    } as unknown as SyncContext

    const resolveDeviceKey = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]))
    const coordinator = new CrdtSyncCoordinator(ctx, resolveDeviceKey)

    await coordinator.applyCrdtBatch(['note-1'], 'token-1', new Uint8Array([4, 5, 6]))
    await coordinator.applyCrdtBatch(['note-1'], 'token-1', new Uint8Array([4, 5, 6]))

    expect(postToServerMock).toHaveBeenNthCalledWith(
      1,
      '/sync/crdt/updates/batch',
      {
        notes: [{ noteId: 'note-1', since: 2 }],
        limit: 100
      },
      'token-1'
    )
    expect(postToServerMock).toHaveBeenNthCalledWith(
      2,
      '/sync/crdt/updates/batch',
      {
        notes: [{ noteId: 'note-1', since: 6 }],
        limit: 100
      },
      'token-1'
    )
  })

  const createBatchContext = (): {
    ctx: SyncContext
    open: ReturnType<typeof vi.fn>
  } => {
    const open = vi.fn().mockResolvedValue({})
    const ctx = {
      deps: {
        crdtProvider: {
          getDoc: vi.fn().mockReturnValue(undefined),
          open,
          closeIfInactive: vi.fn().mockResolvedValue(true),
          applyRemoteUpdate: vi.fn(),
          getStateVector: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4])),
          seedFromMarkdownPublic: vi.fn()
        }
      },
      abortController: new AbortController()
    } as unknown as SyncContext

    return { ctx, open }
  }

  it('does not retry 429s inside the serial pull loop', async () => {
    // #given a normal batch pass
    const { ctx } = createBatchContext()
    postToServerMock.mockResolvedValue({ notes: { 'note-1': { updates: [], hasMore: false } } })
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    // #when
    await coordinator.applyCrdtBatch(['note-1'], 'token-1', new Uint8Array([4, 5, 6]))

    // #then honouring Retry-After (up to 60s) x3 inside a serial loop stalls the
    // whole pass on one note; the pass cadence is the retry instead.
    expect(withRetryMock).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ retryOn429: false })
    )
  })

  it('does not retry 429s when pulling a single note incrementally', async () => {
    // #given
    const { ctx } = createBatchContext()
    getFromServerMock.mockResolvedValue({ updates: [], hasMore: false })
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    // #when
    await coordinator.applyCrdtIncrementals('note-1', 'token-1', new Uint8Array([4, 5, 6]))

    // #then
    expect(withRetryMock).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ retryOn429: false })
    )
  })

  it('keeps syncing the remaining notes when one note fails its snapshot baseline', async () => {
    // #given note-2 dead-letters while fetching its snapshot baseline
    const { ctx } = createBatchContext()
    const deadLetter = new Error('Dead letter after 4 attempts: Server error (500)')
    deadLetter.name = 'DeadLetterError'
    fetchCrdtSnapshotMock
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(deadLetter)
      .mockResolvedValueOnce(null)
    postToServerMock.mockResolvedValue({
      notes: {
        'note-1': { updates: [], hasMore: false },
        'note-3': { updates: [], hasMore: false }
      }
    })
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    // #when
    await coordinator.applyCrdtBatch(['note-1', 'note-2', 'note-3'], 'token-1', new Uint8Array([4]))

    // #then one bad note must not abandon every note after it in the pass
    expect(postToServerMock).toHaveBeenCalledWith(
      '/sync/crdt/updates/batch',
      {
        notes: [
          { noteId: 'note-1', since: 0 },
          { noteId: 'note-3', since: 0 }
        ],
        limit: 100
      },
      'token-1'
    )
  })

  it('does not seed a note whose snapshot baseline failed', async () => {
    // #given note-2's baseline dead-letters; note-1 and note-3 succeed.
    // note-2 was opened with { skipSeed: true } so its state vector is empty.
    const seedFromMarkdownPublic = vi.fn()
    const getStateVector = vi.fn((noteId: string) =>
      noteId === 'note-2' ? new Uint8Array([]) : new Uint8Array([1, 2, 3, 4])
    )
    const ctx = {
      deps: {
        crdtProvider: {
          getDoc: vi.fn().mockReturnValue(undefined),
          open: vi.fn().mockResolvedValue({}),
          closeIfInactive: vi.fn().mockResolvedValue(true),
          applyRemoteUpdate: vi.fn(),
          getStateVector,
          seedFromMarkdownPublic
        }
      },
      abortController: new AbortController()
    } as unknown as SyncContext

    const deadLetter = new Error('Dead letter after 4 attempts: Server error (500)')
    deadLetter.name = 'DeadLetterError'
    fetchCrdtSnapshotMock
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(deadLetter)
      .mockResolvedValueOnce(null)
    postToServerMock.mockResolvedValue({
      notes: {
        'note-1': { updates: [], hasMore: false },
        'note-3': { updates: [], hasMore: false }
      }
    })
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    // #when
    await coordinator.applyCrdtBatch(['note-1', 'note-2', 'note-3'], 'token-1', new Uint8Array([4]))

    // #then seeding note-2 would persist local markdown into its open, empty doc;
    // the next pass's real server snapshot would then merge as an independent
    // insertion → duplicated note body. Only baselined notes may be seeded.
    expect(seedFromMarkdownPublic).not.toHaveBeenCalledWith('note-2')
  })

  it('aborts the whole pass when a snapshot baseline is aborted mid-batch', async () => {
    // #given note-1's baseline is aborted (shutdown/signal), not a transient failure
    const { ctx } = createBatchContext()
    const abort = new DOMException('The operation was aborted', 'AbortError')
    fetchCrdtSnapshotMock.mockRejectedValueOnce(abort)
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    // #when
    await coordinator.applyCrdtBatch(['note-1', 'note-2'], 'token-1', new Uint8Array([4]))

    // #then an abort must propagate, not be swallowed as a skipped note; the pass
    // stops before pulling any updates.
    expect(postToServerMock).not.toHaveBeenCalled()
  })
})

describe('CrdtSyncCoordinator.clearCaches', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('drops the per-note applied-sequence cursors so a new vault starts from the server baseline', async () => {
    const applyRemoteUpdate = vi.fn()
    const crdtProvider = {
      applyRemoteUpdate,
      open: vi.fn().mockResolvedValue({}),
      closeIfInactive: vi.fn().mockResolvedValue(true),
      getDoc: vi.fn().mockReturnValue({}),
      getStateVector: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
      seedFromMarkdownPublic: vi.fn()
    }
    const ctx = {
      deps: { crdtProvider },
      abortController: new AbortController()
    } as unknown as SyncContext
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn().mockResolvedValue(new Uint8Array([9])))

    fetchCrdtSnapshotMock.mockResolvedValue({
      snapshot: new Uint8Array([1]),
      sequenceNum: 2,
      signerDeviceId: 'dev-1'
    })
    decryptCrdtUpdateMock.mockReturnValue(new Uint8Array([1]))
    getFromServerMock
      .mockResolvedValueOnce({
        updates: [{ sequenceNum: 7, data: 'eA==', createdAt: 0, signerDeviceId: 'dev-1' }],
        hasMore: false
      })
      .mockResolvedValue({ updates: [], hasMore: false })

    // #given — a pass that advanced this note's cursor past the snapshot baseline
    await coordinator.applyCrdtIncrementals('note-1', 'token', new Uint8Array([2]))
    coordinator.addPendingPull('note-1')
    getFromServerMock.mockClear()

    // #when — a second pass runs against the same remembered cursor
    await coordinator.applyCrdtIncrementals('note-1', 'token', new Uint8Array([2]))
    expect(getFromServerMock.mock.calls[0][0]).toContain('since=7')

    // #then — after teardown (engine.stop on vault close) the cursor is gone and
    // the next pass restarts from the server snapshot baseline
    coordinator.clearCaches()
    expect(coordinator.pendingPullCount).toBe(0)

    getFromServerMock.mockClear()
    await coordinator.applyCrdtIncrementals('note-1', 'token', new Uint8Array([2]))
    expect(getFromServerMock.mock.calls[0][0]).toContain('since=2')
  })
})
