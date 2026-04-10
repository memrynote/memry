import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncContext } from './sync-context'
import { CrdtSyncCoordinator } from './crdt-sync-coordinator'

const fetchCrdtSnapshotMock = vi.fn()
const postToServerMock = vi.fn()
const decryptCrdtUpdateMock = vi.fn()

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
  postToServer: (...args: unknown[]) => postToServerMock(...args)
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
