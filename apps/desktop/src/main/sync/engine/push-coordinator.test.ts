import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import { SyncQueueManager, DEFAULT_MAX_ATTEMPTS } from '@main/sync/queue'
import { setupTestDb, type TestDatabaseResult } from '@tests/utils/engine-mocks'
import type { SyncContext } from './sync-context'
import type { SyncStateManager } from './sync-state-manager'

const { encryptPushBatchMock, postToServerMock, getHandlerMock, getRemoteSyncAdapterMock } =
  vi.hoisted(() => ({
    encryptPushBatchMock: vi.fn(),
    postToServerMock: vi.fn(),
    getHandlerMock: vi.fn(),
    getRemoteSyncAdapterMock: vi.fn()
  }))

vi.mock('../../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})

// Real crypto would drag libsodium + the worker bridge into a test about queue
// bookkeeping. secureCleanup only zeroes key bytes in the finally block.
vi.mock('../../crypto/index', () => ({ secureCleanup: vi.fn() }))

vi.mock('../sync-crypto-batch', () => ({ encryptPushBatch: encryptPushBatchMock }))

vi.mock('../item-handlers', () => ({
  getHandler: getHandlerMock,
  getRemoteSyncAdapter: getRemoteSyncAdapterMock
}))

// Keep the real SyncServerError / RateLimitError classes: withRetry, withAuthRetry
// and classifyError all branch on `instanceof` and on statusCode.
vi.mock('../http-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../http-client')>()
  return { ...actual, postToServer: postToServerMock }
})

import { PushCoordinator } from './push-coordinator'
import { SyncServerError } from '../http-client'

interface QueueRow {
  id: string
  itemId: string
  type: string
  operation: string
  payload: string
}

/**
 * Stands in for the real encryptPushBatch: still routes each row through the
 * coordinator's own resolvePushPayload (so the fresh-vs-frozen payload path is
 * exercised) and parks the resulting plaintext in `encryptedData`, which lets a
 * test assert *which* payload actually went over the wire.
 */
function fakeEncryptPushBatch(): void {
  encryptPushBatchMock.mockImplementation(
    async (
      items: QueueRow[],
      vaultKey: Uint8Array,
      _signingKey: Uint8Array,
      deviceId: string,
      deps: {
        resolvePushPayload: (item: QueueRow, deviceId: string, vaultKey: Uint8Array) => string
      }
    ) =>
      items.map((item) => ({
        queueId: item.id,
        pushItem: {
          id: item.itemId,
          type: item.type,
          operation: item.operation,
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: deps.resolvePushPayload(item, deviceId, vaultKey),
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: deviceId
        }
      }))
  )
}

interface PushBody {
  items: Array<{ id: string; type: string; operation: string; encryptedData: string }>
}

function createHarness(testDb: TestDatabaseResult): {
  ctx: SyncContext
  queue: SyncQueueManager
  stateManager: SyncStateManager
  coordinator: PushCoordinator
  getAccessToken: ReturnType<typeof vi.fn>
  refreshAccessToken: ReturnType<typeof vi.fn>
  emitToRenderer: ReturnType<typeof vi.fn>
} {
  const queue = new SyncQueueManager(testDb.db)
  const getAccessToken = vi.fn().mockResolvedValue('test-token')
  const refreshAccessToken = vi.fn().mockResolvedValue(false)
  const emitToRenderer = vi.fn()

  const stateValues = new Map<string, string>()
  const stateManager = {
    setState: vi.fn(),
    isPaused: vi.fn(() => false),
    emitItemSynced: vi.fn(),
    recordHistory: vi.fn(),
    updateLastSyncAt: vi.fn(),
    checkClockSkew: vi.fn(),
    getStateValue: vi.fn((key: string) => stateValues.get(key)),
    setStateValue: vi.fn((key: string, value: string) => {
      stateValues.set(key, value)
    })
  } as unknown as SyncStateManager

  const ctx = {
    deps: {
      queue,
      network: { online: true },
      ws: {},
      getAccessToken,
      getVaultKey: vi.fn().mockResolvedValue(new Uint8Array(32)),
      getSigningKeys: vi.fn().mockResolvedValue({
        secretKey: new Uint8Array(64),
        publicKey: new Uint8Array(32),
        deviceId: 'device-1'
      }),
      getDevicePublicKey: vi.fn().mockResolvedValue(null),
      db: testDb.db,
      emitToRenderer,
      refreshAccessToken
    },
    options: { pushBatchSize: 100, pullPageLimit: 100 },
    state: 'idle',
    syncing: false,
    fullSyncActive: false,
    abortController: null,
    inFlightSync: null,
    lastError: undefined,
    lastErrorInfo: undefined,
    offlineSince: null,
    rateLimitConsecutive: 0,
    scheduleSync: vi.fn(),
    acquireLock: vi.fn().mockResolvedValue(() => {}),
    releaseLock: vi.fn(),
    requestPush: vi.fn()
  } as unknown as SyncContext

  return {
    ctx,
    queue,
    stateManager,
    coordinator: new PushCoordinator(ctx, stateManager),
    getAccessToken,
    refreshAccessToken,
    emitToRenderer
  }
}

function acceptAll(): void {
  postToServerMock.mockImplementation(async (_path: string, body: PushBody) => ({
    accepted: body.items.map((i) => i.id),
    rejected: [],
    serverTime: Math.floor(Date.now() / 1000),
    maxCursor: 0
  }))
}

function rejectAllWith(reason: string): void {
  postToServerMock.mockImplementation(async (_path: string, body: PushBody) => ({
    accepted: [],
    rejected: body.items.map((i) => ({ id: i.id, reason })),
    serverTime: Math.floor(Date.now() / 1000),
    maxCursor: 0
  }))
}

describe('PushCoordinator', () => {
  const { getDb } = setupTestDb()

  beforeEach(() => {
    vi.clearAllMocks()
    fakeEncryptPushBatch()
    getHandlerMock.mockReturnValue(undefined)
    getRemoteSyncAdapterMock.mockReturnValue(undefined)
  })

  describe('#given a queued local mutation #when the server accepts it', () => {
    it('#then it is pushed, dropped from the queue, and marked synced locally', async () => {
      const { coordinator, queue, stateManager, emitToRenderer } = createHarness(getDb())
      const markPushSynced = vi.fn()
      getHandlerMock.mockReturnValue({ markPushSynced })
      acceptAll()

      queue.enqueue({
        type: 'note',
        itemId: 'note-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Hello' })
      })

      await coordinator.push()

      expect(postToServerMock).toHaveBeenCalledTimes(1)
      expect(postToServerMock.mock.calls[0][0]).toBe('/sync/push')
      const body = postToServerMock.mock.calls[0][1] as PushBody
      expect(body.items).toHaveLength(1)
      expect(body.items[0]).toMatchObject({ id: 'note-1', type: 'note', operation: 'create' })

      expect(queue.getSize()).toBe(0)
      expect(markPushSynced).toHaveBeenCalledWith(expect.anything(), 'note-1')
      expect(stateManager.emitItemSynced).toHaveBeenCalledWith('note-1', 'note', 'push')
      expect(stateManager.updateLastSyncAt).toHaveBeenCalled()
      expect(emitToRenderer).toHaveBeenCalledWith(
        EVENT_CHANNELS.QUEUE_CLEARED,
        expect.objectContaining({ itemCount: 1 })
      )
    })

    it('#then it advances the pull cursor when the server reports a higher maxCursor', async () => {
      const { coordinator, queue, stateManager } = createHarness(getDb())
      postToServerMock.mockResolvedValue({
        accepted: ['note-1'],
        rejected: [],
        serverTime: Math.floor(Date.now() / 1000),
        maxCursor: 42
      })

      queue.enqueue({
        type: 'note',
        itemId: 'note-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Hello' })
      })

      await coordinator.push()

      expect(stateManager.setStateValue).toHaveBeenCalledWith('lastCursor', '42')
    })
  })

  describe('#given the push request fails #when push runs', () => {
    it('#then the item stays queued and is NOT marked synced, so the next cycle retries it', async () => {
      const { coordinator, queue, stateManager } = createHarness(getDb())
      const markPushSynced = vi.fn()
      getHandlerMock.mockReturnValue({ markPushSynced })
      // 4xx so withRetry rethrows immediately instead of sleeping through backoff.
      postToServerMock.mockRejectedValue(new SyncServerError('Bad request', 400))

      const payload = JSON.stringify({ title: 'Unsent edit' })
      queue.enqueue({ type: 'task', itemId: 'task-1', operation: 'update', payload })

      await coordinator.push()

      expect(queue.getPendingCount()).toBe(1)
      const [row] = queue.peek()
      expect(row.payload).toBe(payload)
      // The whole request blew up, so no per-item attempt was consumed.
      expect(row.attempts).toBe(0)
      expect(markPushSynced).not.toHaveBeenCalled()
      expect(stateManager.setState).toHaveBeenCalledWith('error')
      expect(stateManager.updateLastSyncAt).not.toHaveBeenCalled()
    })

    it('#then a server-side rejection of the item keeps the row instead of deleting it', async () => {
      const { coordinator, queue } = createHarness(getDb())
      const markPushSynced = vi.fn()
      getHandlerMock.mockReturnValue({ markPushSynced })
      rejectAllWith('SYNC_VALIDATION_FAILED')

      const payload = JSON.stringify({ title: 'Rejected edit' })
      queue.enqueue({ type: 'task', itemId: 'task-1', operation: 'update', payload })

      await coordinator.push()

      // Never deleted, never marked synced — the user's edit is still on disk.
      expect(queue.getSize()).toBe(1)
      expect(queue.peek()[0].payload).toBe(payload)
      expect(markPushSynced).not.toHaveBeenCalled()
      // One cycle costs exactly one attempt. The push loop has no backoff, so a
      // row re-pushed inside the same call would burn the whole budget against a
      // single burst of requests and dead-letter a transiently rejected edit for
      // good; the row is deferred to the next cycle instead.
      expect(postToServerMock).toHaveBeenCalledTimes(1)
      expect(queue.peek()[0].attempts).toBe(1)
      expect(queue.getPendingCount()).toBe(1)
    })

    it('#then the attempt budget still dead-letters the row, but only after one cycle each', async () => {
      const { coordinator, queue } = createHarness(getDb())
      rejectAllWith('SYNC_VALIDATION_FAILED')

      queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'update',
        payload: JSON.stringify({ title: 'Doomed edit' })
      })

      for (let cycle = 1; cycle <= DEFAULT_MAX_ATTEMPTS; cycle++) {
        await coordinator.push()
        expect(queue.peek()[0].attempts).toBe(cycle)
      }

      // The brake is intact: the budget is spent, just spread over cycles.
      expect(postToServerMock).toHaveBeenCalledTimes(DEFAULT_MAX_ATTEMPTS)
      expect(queue.getPendingCount()).toBe(0)

      // And a spent budget really does stop the pushing.
      await coordinator.push()
      expect(postToServerMock).toHaveBeenCalledTimes(DEFAULT_MAX_ATTEMPTS)
    })

    it('#then a rejected row does not block the rows queued behind it in the same cycle', async () => {
      const { coordinator, queue, ctx } = createHarness(getDb())
      // One row per request, so the rejected row is at the head of every dequeue.
      ctx.options.pushBatchSize = 1
      postToServerMock.mockImplementation(async (_path: string, body: PushBody) => {
        const rejected = body.items.filter((i) => i.id === 'task-1')
        return {
          accepted: body.items.filter((i) => i.id !== 'task-1').map((i) => i.id),
          rejected: rejected.map((i) => ({ id: i.id, reason: 'SYNC_VALIDATION_FAILED' })),
          serverTime: Math.floor(Date.now() / 1000),
          maxCursor: 0
        }
      })

      queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'update',
        payload: JSON.stringify({ title: 'Rejected' })
      })
      queue.enqueue({
        type: 'task',
        itemId: 'task-2',
        operation: 'update',
        payload: JSON.stringify({ title: 'Fine' })
      })

      await coordinator.push()

      // Two requests: the rejected row is skipped for the rest of the cycle
      // rather than re-sent, and the healthy row behind it still goes out.
      expect(postToServerMock).toHaveBeenCalledTimes(2)
      expect(queue.peek()).toHaveLength(1)
      expect(queue.peek()[0].itemId).toBe('task-1')
      expect(queue.peek()[0].attempts).toBe(1)
    })

    it('#then a replay rejection is treated as already-synced and drops the row', async () => {
      const { coordinator, queue } = createHarness(getDb())
      const markPushSynced = vi.fn()
      getHandlerMock.mockReturnValue({ markPushSynced })
      postToServerMock.mockImplementation(async (_path: string, body: PushBody) => ({
        accepted: [],
        rejected: body.items.map((i) => ({ id: i.id, reason: 'SYNC_REPLAY_DETECTED' })),
        serverTime: Math.floor(Date.now() / 1000),
        maxCursor: 0
      }))

      queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'update',
        payload: JSON.stringify({ title: 'Already on server' })
      })

      await coordinator.push()

      expect(queue.getSize()).toBe(0)
      expect(markPushSynced).toHaveBeenCalledWith(expect.anything(), 'task-1')
    })
  })

  describe('#given the access token is stale #when the server answers 401', () => {
    it('#then the session is refreshed, the push retried with the fresh token, and nothing is dropped', async () => {
      const { coordinator, queue, getAccessToken, refreshAccessToken } = createHarness(getDb())
      getAccessToken.mockResolvedValueOnce('test-token').mockResolvedValue('fresh-token')
      refreshAccessToken.mockResolvedValue(true)
      postToServerMock
        .mockRejectedValueOnce(new SyncServerError('Unauthorized', 401))
        .mockImplementation(async (_path: string, body: PushBody) => ({
          accepted: body.items.map((i) => i.id),
          rejected: [],
          serverTime: Math.floor(Date.now() / 1000),
          maxCursor: 0
        }))

      queue.enqueue({
        type: 'note',
        itemId: 'note-1',
        operation: 'update',
        payload: JSON.stringify({ title: 'Retry me' })
      })

      await coordinator.push()

      expect(refreshAccessToken).toHaveBeenCalledTimes(1)
      expect(postToServerMock).toHaveBeenCalledTimes(2)
      expect(postToServerMock.mock.calls[0][2]).toBe('test-token')
      expect(postToServerMock.mock.calls[1][2]).toBe('fresh-token')
      expect(queue.getSize()).toBe(0)
    })

    it('#then an unrefreshable 401 propagates but leaves the queued edit untouched', async () => {
      const { coordinator, queue, refreshAccessToken } = createHarness(getDb())
      refreshAccessToken.mockResolvedValue(false)
      postToServerMock.mockRejectedValue(new SyncServerError('Unauthorized', 401))

      const payload = JSON.stringify({ title: 'Still mine' })
      queue.enqueue({ type: 'note', itemId: 'note-1', operation: 'update', payload })

      // auth_expired is rethrown so the engine's error recovery can run.
      await expect(coordinator.push()).rejects.toThrow()

      expect(queue.getPendingCount()).toBe(1)
      expect(queue.peek()[0].payload).toBe(payload)
      expect(queue.peek()[0].attempts).toBe(0)
    })
  })

  describe('#given the account is out of storage #when push runs', () => {
    it('#then an HTTP 413 with the quota code surfaces as storage_quota_exceeded without discarding the item', async () => {
      const { coordinator, queue, ctx, stateManager } = createHarness(getDb())
      postToServerMock.mockRejectedValue(
        new SyncServerError(
          'Storage quota exceeded',
          413,
          '{"error":{"code":"STORAGE_QUOTA_EXCEEDED","message":"Storage quota exceeded"}}'
        )
      )

      const payload = JSON.stringify({ title: 'Too big' })
      queue.enqueue({ type: 'note', itemId: 'note-1', operation: 'update', payload })

      await coordinator.push()

      expect(ctx.lastErrorInfo?.category).toBe('storage_quota_exceeded')
      expect(stateManager.setState).toHaveBeenCalledWith('error')
      expect(queue.getSize()).toBe(1)
      expect(queue.peek()[0].payload).toBe(payload)
    })

    it('#then a bare HTTP 413 surfaces as note_too_large, not storage_quota_exceeded', async () => {
      // A 413 without the quota code comes from a body-size layer (the server's
      // body-limit middleware, an edge proxy) — telling the user their storage
      // is full would send them to free up space, which never fixes it.
      const { coordinator, queue, ctx, stateManager } = createHarness(getDb())
      postToServerMock.mockRejectedValue(new SyncServerError('Payload too large', 413))

      const payload = JSON.stringify({ title: 'Too big' })
      queue.enqueue({ type: 'note', itemId: 'note-1', operation: 'update', payload })

      await coordinator.push()

      expect(ctx.lastErrorInfo?.category).toBe('note_too_large')
      expect(stateManager.setState).toHaveBeenCalledWith('error')
      expect(queue.getSize()).toBe(1)
      expect(queue.peek()[0].payload).toBe(payload)
    })

    it('#then a per-item STORAGE_QUOTA_EXCEEDED rejection keeps the row and stops the batch', async () => {
      const { coordinator, queue, ctx, stateManager } = createHarness(getDb())
      const markPushSynced = vi.fn()
      getHandlerMock.mockReturnValue({ markPushSynced })
      postToServerMock.mockImplementation(async (_path: string, body: PushBody) => ({
        accepted: [],
        rejected: body.items.map((i) => ({ id: i.id, reason: 'STORAGE_QUOTA_EXCEEDED' })),
        serverTime: Math.floor(Date.now() / 1000),
        maxCursor: 0
      }))

      const payload = JSON.stringify({ title: 'Over quota' })
      queue.enqueue({ type: 'note', itemId: 'note-1', operation: 'update', payload })

      await coordinator.push()

      expect(queue.getSize()).toBe(1)
      expect(queue.peek()[0].payload).toBe(payload)
      expect(markPushSynced).not.toHaveBeenCalled()
      expect(ctx.lastErrorInfo).toEqual({
        category: 'storage_quota_exceeded',
        message: 'errors:sync.storageQuotaExceeded',
        retryable: false
      })
      expect(ctx.lastError).toBe('errors:sync.storageQuotaExceeded')
      expect(stateManager.setState).toHaveBeenCalledWith('error')
    })
  })

  describe('#given a second edit lands while the first is in flight', () => {
    it('#then the newer payload survives and is the one that reaches the server', async () => {
      const { coordinator, queue } = createHarness(getDb())
      const markSuccessSpy = vi.spyOn(queue, 'markSuccess')

      const v1 = JSON.stringify({ title: 'first' })
      const v2 = JSON.stringify({ title: 'second' })
      queue.enqueue({ type: 'task', itemId: 'task-1', operation: 'update', payload: v1 })

      let coalesced = false
      postToServerMock.mockImplementation(async (_path: string, body: PushBody) => {
        if (!coalesced) {
          coalesced = true
          // enqueue() coalesces into the same attempts=0 row that is in flight.
          queue.enqueue({ type: 'task', itemId: 'task-1', operation: 'update', payload: v2 })
        }
        return {
          accepted: body.items.map((i) => i.id),
          rejected: [],
          serverTime: Math.floor(Date.now() / 1000),
          maxCursor: 0
        }
      })

      await coordinator.push()

      // The ack for the first push is payload-conditional, so it must NOT delete
      // the row that now holds v2. (Losing that delete guard is what once synced
      // renamed notes across devices as "Untitled".)
      expect(markSuccessSpy.mock.results[0].value).toBe(false)

      expect(postToServerMock).toHaveBeenCalledTimes(2)
      const first = postToServerMock.mock.calls[0][1] as PushBody
      const second = postToServerMock.mock.calls[1][1] as PushBody
      expect(first.items[0].encryptedData).toBe(v1)
      expect(second.items[0].encryptedData).toBe(v2)

      expect(queue.getSize()).toBe(0)
    })
  })

  describe('#given two queue rows for the same item in one batch', () => {
    it('#then only one is pushed and the pushed payload is rebuilt fresh from local state', async () => {
      const { coordinator, queue } = createHarness(getDb())
      acceptAll()

      const v1 = JSON.stringify({ title: 'first' })
      const v2 = JSON.stringify({ title: 'second' })
      queue.enqueue({ type: 'task', itemId: 'task-1', operation: 'update', payload: v1 })
      // attempts > 0 stops enqueue() from coalescing, so the next edit opens a
      // second row for the same (type, itemId).
      queue.markFailed(queue.peek()[0].id, 'transient')
      queue.enqueue({ type: 'task', itemId: 'task-1', operation: 'update', payload: v2 })
      expect(queue.getSize()).toBe(2)

      // Handlers rebuild the payload from the DB at push time; that rebuild — not
      // the frozen queue payload — is what carries the newest local state.
      getHandlerMock.mockReturnValue({ buildPushPayload: () => v2, markPushSynced: vi.fn() })

      await coordinator.push()

      expect(postToServerMock).toHaveBeenCalledTimes(1)
      const body = postToServerMock.mock.calls[0][1] as PushBody
      expect(body.items).toHaveLength(1)
      expect(body.items[0].encryptedData).toBe(v2)
      expect(queue.getSize()).toBe(0)
    })

    // `buildPushPayload` is optional on SyncItemHandler and `settings` omits it,
    // so nothing rebuilds the payload from local state — the frozen queue
    // payload is what goes over the wire. The retained row therefore has to be
    // the newer one, or the newer edit is deleted via the success path having
    // never been pushed (#953).
    it('#then the newer payload is pushed even when the handler cannot rebuild it', async () => {
      const { coordinator, queue } = createHarness(getDb())
      acceptAll()
      getHandlerMock.mockReturnValue({ markPushSynced: vi.fn() })

      const v1 = JSON.stringify({ general: { theme: 'light' } })
      const v2 = JSON.stringify({ general: { theme: 'dark' } })
      queue.enqueue({
        type: 'settings',
        itemId: 'synced_settings',
        operation: 'update',
        payload: v1
      })
      queue.markFailed(queue.peek()[0].id, 'transient')
      queue.enqueue({
        type: 'settings',
        itemId: 'synced_settings',
        operation: 'update',
        payload: v2
      })
      expect(queue.getSize()).toBe(2)

      await coordinator.push()

      expect(postToServerMock).toHaveBeenCalledTimes(1)
      const body = postToServerMock.mock.calls[0][1] as PushBody
      expect(body.items).toHaveLength(1)
      expect(body.items[0].encryptedData).toBe(v2)
      expect(queue.getSize()).toBe(0)
    })

    // Keeping the newest row must not silently downgrade the operation: the
    // create was never acked, so an `update` for an id the server has never
    // seen is not an equivalent request. Same precedence enqueue() applies.
    it('#then an unacked create survives a newer update row', async () => {
      const { coordinator, queue } = createHarness(getDb())
      acceptAll()
      getHandlerMock.mockReturnValue({ markPushSynced: vi.fn() })

      const v1 = JSON.stringify({ title: 'first' })
      const v2 = JSON.stringify({ title: 'second' })
      queue.enqueue({ type: 'task', itemId: 'task-2', operation: 'create', payload: v1 })
      queue.markFailed(queue.peek()[0].id, 'transient')
      queue.enqueue({ type: 'task', itemId: 'task-2', operation: 'update', payload: v2 })

      await coordinator.push()

      const body = postToServerMock.mock.calls[0][1] as PushBody
      expect(body.items).toHaveLength(1)
      expect(body.items[0].operation).toBe('create')
      expect(body.items[0].encryptedData).toBe(v2)
      expect(queue.getSize()).toBe(0)
    })
  })

  describe('#given sync is paused #when requestPush is called', () => {
    it('#then no push is scheduled', () => {
      const { coordinator, ctx, stateManager } = createHarness(getDb())
      vi.mocked(stateManager.isPaused).mockReturnValue(true)

      coordinator.requestPush()

      expect(ctx.scheduleSync).not.toHaveBeenCalled()
      coordinator.clearDebounce()
    })
  })
})
