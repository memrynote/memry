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

vi.mock('../retry', () => ({
  withRetry: async <T>(fn: () => Promise<T>) => ({ value: await fn() })
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
          open,
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
    expect(getFromServerMock).toHaveBeenCalledWith(
      '/sync/crdt/updates?note_id=note-1&since=0&limit=100',
      'token-1'
    )
    expect(applyRemoteUpdate).toHaveBeenCalledWith('note-1', new Uint8Array([7, 7, 7]))
    expect(seedFromMarkdownPublic).toHaveBeenCalledWith('note-1')
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
          open,
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
          open,
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
})
