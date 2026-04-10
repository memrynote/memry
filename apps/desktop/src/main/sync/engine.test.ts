import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { SyncEngine, type SyncEngineDeps } from './engine'
import { SyncQueueManager } from './queue'
import { NetworkMonitor } from './network'
import { NetworkError } from './http-client'
import type { WebSocketManager, WebSocketMessage } from './websocket'

function createMockNetwork(online = true): NetworkMonitor {
  const monitor = new EventEmitter() as NetworkMonitor & { _online: boolean }
  monitor._online = online
  Object.defineProperty(monitor, 'online', { get: () => monitor._online })
  monitor.start = vi.fn()
  monitor.stop = vi.fn()
  return monitor
}

function createMockWs(): WebSocketManager & { simulateConnected: () => void } {
  const ws = new EventEmitter() as WebSocketManager & {
    _connected: boolean
    simulateConnected: () => void
  }
  ws._connected = false
  Object.defineProperty(ws, 'connected', { get: () => ws._connected })
  ws.connect = vi.fn(async () => {
    ws._connected = true
  })
  ws.disconnect = vi.fn(() => {
    ws._connected = false
  })
  ws.simulateConnected = () => {
    ws.emit('connected')
  }
  return ws
}

function createMockDeps(
  db: TestDatabaseResult,
  overrides?: Partial<SyncEngineDeps>
): SyncEngineDeps {
  return {
    queue: new SyncQueueManager(db.db),
    network: createMockNetwork(),
    ws: createMockWs(),
    getAccessToken: vi.fn().mockResolvedValue('test-token'),
    getVaultKey: vi.fn().mockResolvedValue(new Uint8Array(32)),
    getSigningKeys: vi.fn().mockResolvedValue({
      secretKey: new Uint8Array(64),
      publicKey: new Uint8Array(32),
      deviceId: 'device-1'
    }),
    getDevicePublicKey: vi.fn().mockResolvedValue(new Uint8Array(32)),
    db: db.db,
    emitToRenderer: vi.fn(),
    ...overrides
  }
}

describe('SyncEngine', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDataDb()
  })

  afterEach(() => {
    testDb.close()
  })

  describe('#given new engine #when constructed', () => {
    it('#then initial state is idle', () => {
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      expect(engine.currentState).toBe('idle')
    })
  })

  describe('#given engine #when start called while online', () => {
    it('#then connects WebSocket', async () => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      await engine.start()
      await engine.stop()

      expect(deps.ws.connect).toHaveBeenCalled()
      vi.restoreAllMocks()
    })
  })

  describe('#given engine #when start called while offline', () => {
    it('#then sets state to offline', async () => {
      const network = createMockNetwork(false)
      const deps = createMockDeps(testDb, { network })
      const engine = new SyncEngine(deps)

      await engine.start()

      expect(engine.currentState).toBe('offline')
    })
  })

  describe('#given engine #when stop called', () => {
    it('#then disconnects WebSocket and goes idle', async () => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)
      await engine.start()

      await engine.stop()

      expect(deps.ws.disconnect).toHaveBeenCalled()
      expect(engine.currentState).toBe('idle')
      vi.restoreAllMocks()
    })
  })

  describe('#given engine with queued items #when push called', () => {
    it('#then encrypts and sends items to server', async () => {
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'note',
        itemId: 'note-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Test' })
      })

      const mockEncrypt = vi.fn().mockReturnValue({
        pushItem: {
          id: 'note-1',
          type: 'note',
          operation: 'create',
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1'
        },
        sizeBytes: 100
      })

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockImplementation(mockEncrypt)

      const mockPost = vi.fn().mockResolvedValue({
        accepted: ['note-1'],
        rejected: [],
        serverTime: Date.now()
      })
      vi.spyOn(await import('./http-client'), 'postToServer').mockImplementation(mockPost)

      await engine.push()

      expect(mockEncrypt).toHaveBeenCalled()
      expect(mockPost).toHaveBeenCalled()
      expect(deps.queue.getPendingCount()).toBe(0)

      vi.restoreAllMocks()
    })
  })

  describe('#given engine with empty queue #when push called', () => {
    it('#then returns without making network calls', async () => {
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      const postSpy = vi.spyOn(await import('./http-client'), 'postToServer')

      await engine.push()

      expect(postSpy).not.toHaveBeenCalled()
      vi.restoreAllMocks()
    })
  })

  describe('#given engine pull #when posting to /sync/pull', () => {
    it('#then sends camelCase itemIds and includes deleted refs', async () => {
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [{ id: 'task-1', type: 'task', version: 1, modifiedAt: 1000, size: 10 }],
        deleted: ['task-2'],
        hasMore: false,
        nextCursor: 1
      })

      const postSpy = vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        items: []
      })

      await engine.pull()

      expect(postSpy).toHaveBeenCalledWith(
        '/sync/pull',
        { itemIds: ['task-1', 'task-2'] },
        'test-token'
      )
      vi.restoreAllMocks()
    })
  })

  describe('#given engine #when getStatus called', () => {
    it('#then returns current state with pending count', () => {
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'note',
        itemId: 'note-1',
        operation: 'create',
        payload: '{}'
      })

      const status = engine.getStatus()

      expect(status.status).toBe('idle')
      expect(status.pendingCount).toBe(1)
    })
  })

  describe('#given engine #when pause called', () => {
    it('#then stores paused state and emits event', () => {
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      const result = engine.pause()

      expect(result.success).toBe(true)
      expect(result.wasPaused).toBe(false)
      expect(deps.emitToRenderer).toHaveBeenCalledWith(
        'sync:paused',
        expect.objectContaining({ pendingCount: 0 })
      )
    })

    it('#then prevents push and pull', async () => {
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      engine.pause()
      deps.queue.enqueue({
        type: 'note',
        itemId: 'note-1',
        operation: 'create',
        payload: '{}'
      })

      await engine.push()

      expect(deps.queue.getPendingCount()).toBe(1)
    })
  })

  describe('#given paused engine #when resume called', () => {
    it('#then clears paused state and emits event', async () => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)
      engine.pause()

      const result = engine.resume()

      expect(result.success).toBe(true)
      expect(deps.emitToRenderer).toHaveBeenCalledWith(
        'sync:resumed',
        expect.objectContaining({ pendingCount: 0 })
      )
      await engine.stop()
      vi.restoreAllMocks()
    })
  })

  describe('#given paused engine #when pause called again', () => {
    it('#then reports wasPaused=true', () => {
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)
      engine.pause()

      const result = engine.pause()

      expect(result.wasPaused).toBe(true)
    })
  })

  describe('#given engine #when network goes offline', () => {
    it('#then transitions to offline state', async () => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })
      const network = createMockNetwork(true)
      const deps = createMockDeps(testDb, { network })
      const engine = new SyncEngine(deps)
      await engine.start()
      ;(network as unknown as { _online: boolean })._online = false
      network.emit('status-changed', { online: false })

      expect(engine.currentState).toBe('offline')
      expect(deps.ws.disconnect).toHaveBeenCalled()
      await engine.stop()
      vi.restoreAllMocks()
    })
  })

  describe('#given offline engine #when network comes back', () => {
    it('#then transitions out of offline and reconnects WS', async () => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })
      const network = createMockNetwork(false)
      const deps = createMockDeps(testDb, { network })
      const engine = new SyncEngine(deps)
      await engine.start()

      expect(engine.currentState).toBe('offline')
      ;(network as unknown as { _online: boolean })._online = true
      network.emit('status-changed', { online: true })

      await vi.waitFor(() => {
        expect(engine.currentState).not.toBe('offline')
      })
      expect(deps.ws.connect).toHaveBeenCalled()

      await engine.stop()
      vi.restoreAllMocks()
    })
  })

  describe('#given rapid offline-online bounce while reconnecting', () => {
    it('#then ignores stale reconnect attempt and reconnects once', async () => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })
      let resolveFirstOnlineToken: ((token: string | null) => void) | null = null
      const firstOnlineToken = new Promise<string | null>((resolve) => {
        resolveFirstOnlineToken = resolve
      })
      const getAccessToken = vi
        .fn()
        .mockResolvedValueOnce('test-token')
        .mockReturnValueOnce(firstOnlineToken)
        .mockResolvedValue('test-token')

      const network = createMockNetwork(false)
      const deps = createMockDeps(testDb, { network, getAccessToken })
      const engine = new SyncEngine(deps)
      await engine.start()
      ;(network as unknown as { _online: boolean })._online = true
      network.emit('status-changed', { online: true })
      ;(network as unknown as { _online: boolean })._online = false
      network.emit('status-changed', { online: false })
      ;(network as unknown as { _online: boolean })._online = true
      network.emit('status-changed', { online: true })

      await vi.waitFor(() => {
        expect(deps.ws.connect).toHaveBeenCalledTimes(1)
      })

      resolveFirstOnlineToken?.('test-token')
      await new Promise((r) => setTimeout(r, 0))

      expect(deps.ws.connect).toHaveBeenCalledTimes(1)

      await engine.stop()
      vi.restoreAllMocks()
    })
  })

  describe('#given connected engine #when WS receives changes_available', () => {
    it('#then triggers pull', async () => {
      const getServerMock = vi.fn().mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })
      vi.spyOn(await import('./http-client'), 'getFromServer').mockImplementation(getServerMock)

      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)
      await engine.start()

      getServerMock.mockClear()

      const pullDone = new Promise<void>((resolve) => {
        const origPull = engine.pull.bind(engine)
        engine.pull = async () => {
          await origPull()
          resolve()
        }
      })

      deps.ws.emit('message', {
        type: 'changes_available',
        payload: {}
      } as WebSocketMessage)

      await pullDone

      expect(getServerMock).toHaveBeenCalled()
      await engine.stop()
      vi.restoreAllMocks()
    })
  })

  describe('#given engine #when concurrent sync requested', () => {
    it('#then second call returns early (sync lock)', async () => {
      let resolveFirst!: () => void
      const blockingPromise = new Promise<void>((r) => {
        resolveFirst = r
      })

      const getServerMock = vi.fn().mockImplementation(() =>
        blockingPromise.then(() => ({
          items: [],
          deleted: [],
          hasMore: false,
          nextCursor: 0
        }))
      )
      vi.spyOn(await import('./http-client'), 'getFromServer').mockImplementation(getServerMock)

      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      const first = engine.pull()
      const second = engine.pull()

      resolveFirst()
      await first
      await second

      expect(getServerMock).toHaveBeenCalledTimes(1)

      vi.restoreAllMocks()
    })
  })

  describe('#given engine #when no access token', () => {
    it('#then push returns without action', async () => {
      const deps = createMockDeps(testDb, {
        getAccessToken: vi.fn().mockResolvedValue(null)
      })
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'note',
        itemId: 'note-1',
        operation: 'create',
        payload: '{}'
      })

      await engine.push()

      expect(deps.queue.getPendingCount()).toBe(1)
    })
  })

  describe('#given engine #when status changes', () => {
    it('#then emits to renderer via EVENT_CHANNELS.STATUS_CHANGED', async () => {
      const network = createMockNetwork(false)
      const deps = createMockDeps(testDb, { network })
      const engine = new SyncEngine(deps)

      await engine.start()

      expect(deps.emitToRenderer).toHaveBeenCalledWith(
        'sync:status-changed',
        expect.objectContaining({ status: 'offline' })
      )
    })
  })

  describe('#given engine #when push succeeds', () => {
    it('#then updates lastSyncAt', async () => {
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'note',
        itemId: 'note-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Test' })
      })

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockReturnValue({
        pushItem: {
          id: 'note-1',
          type: 'note',
          operation: 'create',
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1'
        },
        sizeBytes: 100
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['note-1'],
        rejected: [],
        serverTime: Date.now()
      })

      expect(engine.getStatus().lastSyncAt).toBeUndefined()

      await engine.push()

      expect(engine.getStatus().lastSyncAt).toBeDefined()
      vi.restoreAllMocks()
    })
  })

  describe('#given engine #when push fails with error', () => {
    it('#then does NOT update lastSyncAt', async () => {
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'note',
        itemId: 'note-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Test' })
      })

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockImplementation(() => {
        throw new Error('Encryption failed')
      })

      await engine.push()

      expect(engine.getStatus().lastSyncAt).toBeUndefined()
      expect(engine.currentState).toBe('error')
      vi.restoreAllMocks()
    })
  })

  describe('#given engine with empty queue #when push called', () => {
    it('#then does NOT update lastSyncAt', async () => {
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      expect(engine.getStatus().lastSyncAt).toBeUndefined()

      await engine.push()

      expect(engine.getStatus().lastSyncAt).toBeUndefined()
    })
  })

  describe('#given engine with mixed server accept/reject #when push called', () => {
    it('#then calls markSuccess for accepted and markFailed for rejected', async () => {
      // #given
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'A' })
      })
      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-2',
        operation: 'create',
        payload: JSON.stringify({ title: 'B' })
      })

      const markSuccessSpy = vi.spyOn(deps.queue, 'markSuccess')
      const markFailedSpy = vi.spyOn(deps.queue, 'markFailed')

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockImplementation((input) => ({
        pushItem: {
          id: input.id,
          type: input.type,
          operation: input.operation,
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1'
        },
        sizeBytes: 100
      }))

      // #when server accepts task-1 but rejects task-2
      vi.spyOn(await import('./http-client'), 'postToServer').mockImplementation(
        async (_url: string, body: { items: Array<{ id: string }> }) => {
          const accepted = body.items.filter((i) => i.id === 'task-1').map((i) => i.id)
          const rejected = body.items
            .filter((i) => i.id !== 'task-1')
            .map((i) => ({ id: i.id, reason: 'Conflict' }))
          return { accepted, rejected, serverTime: Math.floor(Date.now() / 1000) }
        }
      )

      await engine.push()

      // #then task-1 accepted once, task-2 rejected until dead-lettered (5 attempts)
      expect(markSuccessSpy).toHaveBeenCalledTimes(1)
      expect(markFailedSpy.mock.calls.length).toBeGreaterThanOrEqual(1)
      expect(markFailedSpy).toHaveBeenCalledWith(expect.any(String), 'Conflict')

      vi.restoreAllMocks()
    })
  })

  describe('#given engine #when push drains queue completely', () => {
    it('#then emits QUEUE_CLEARED event', async () => {
      // #given
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Test' })
      })

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockReturnValue({
        pushItem: {
          id: 'task-1',
          type: 'task',
          operation: 'create',
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1'
        },
        sizeBytes: 100
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['task-1'],
        rejected: [],
        serverTime: Math.floor(Date.now() / 1000)
      })

      // #when
      await engine.push()

      // #then
      expect(deps.emitToRenderer).toHaveBeenCalledWith(
        'sync:queue-cleared',
        expect.objectContaining({ itemCount: 1, duration: expect.any(Number) })
      )

      vi.restoreAllMocks()
    })
  })

  describe('#given server time skewed >5min #when push succeeds', () => {
    it('#then emits CLOCK_SKEW_WARNING event', async () => {
      // #given
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Test' })
      })

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockReturnValue({
        pushItem: {
          id: 'task-1',
          type: 'task',
          operation: 'create',
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1'
        },
        sizeBytes: 100
      })

      // #when server clock is 10 minutes in the future
      const skewedServerTime = Math.floor(Date.now() / 1000) + 600
      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['task-1'],
        rejected: [],
        serverTime: skewedServerTime
      })

      await engine.push()

      // #then
      expect(deps.emitToRenderer).toHaveBeenCalledWith(
        'sync:clock-skew-warning',
        expect.objectContaining({
          serverTime: skewedServerTime,
          skewSeconds: expect.any(Number)
        })
      )

      vi.restoreAllMocks()
    })
  })

  describe('#given server time within 5min #when push succeeds', () => {
    it('#then does NOT emit clock skew warning', async () => {
      // #given
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Test' })
      })

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockReturnValue({
        pushItem: {
          id: 'task-1',
          type: 'task',
          operation: 'create',
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1'
        },
        sizeBytes: 100
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['task-1'],
        rejected: [],
        serverTime: Math.floor(Date.now() / 1000) + 60
      })

      // #when
      await engine.push()

      // #then
      const clockSkewCalls = (deps.emitToRenderer as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([channel]: [string]) => channel === 'sync:clock-skew-warning'
      )
      expect(clockSkewCalls).toHaveLength(0)

      vi.restoreAllMocks()
    })
  })

  describe('#given 150+ queued items #when push called', () => {
    it('#then sends multiple batches', async () => {
      // #given — use small batch size so 3 items = 2 batches
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps, { pushBatchSize: 2, pullPageLimit: 100 })

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'A' })
      })
      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-2',
        operation: 'create',
        payload: JSON.stringify({ title: 'B' })
      })
      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-3',
        operation: 'create',
        payload: JSON.stringify({ title: 'C' })
      })

      let encryptCallIdx = 0
      const ids = ['task-1', 'task-2', 'task-3']
      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockImplementation(() => {
        const id = ids[encryptCallIdx % ids.length]
        encryptCallIdx++
        return {
          pushItem: {
            id,
            type: 'task',
            operation: 'create',
            encryptedKey: 'ek',
            keyNonce: 'kn',
            encryptedData: 'ed',
            dataNonce: 'dn',
            signature: 'sig',
            signerDeviceId: 'device-1'
          },
          sizeBytes: 100
        }
      })

      const postMock = vi
        .fn()
        .mockImplementation(async (_url: string, body: { items: Array<{ id: string }> }) => ({
          accepted: body.items.map((i: { id: string }) => i.id),
          rejected: [],
          serverTime: Math.floor(Date.now() / 1000)
        }))
      vi.spyOn(await import('./http-client'), 'postToServer').mockImplementation(postMock)

      // #when
      await engine.push()

      // #then 2 batches: [task-1, task-2] and [task-3]
      expect(postMock).toHaveBeenCalledTimes(2)
      expect(deps.queue.getPendingCount()).toBe(0)

      vi.restoreAllMocks()
    })
  })

  describe('#given clock skew detection', () => {
    it('#then pauses sync when skew exceeds threshold', async () => {
      // #given
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Test' })
      })

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockReturnValue({
        pushItem: {
          id: 'task-1',
          type: 'task',
          operation: 'create',
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1'
        },
        sizeBytes: 100
      })

      const skewedServerTime = Math.floor(Date.now() / 1000) + 600
      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['task-1'],
        rejected: [],
        serverTime: skewedServerTime
      })

      // #when
      await engine.push()

      // #then — emits event AND pauses
      expect(deps.emitToRenderer).toHaveBeenCalledWith(
        'sync:clock-skew-warning',
        expect.objectContaining({ skewSeconds: expect.any(Number) })
      )
      expect(deps.emitToRenderer).toHaveBeenCalledWith(
        'sync:paused',
        expect.objectContaining({ pendingCount: expect.any(Number) })
      )

      vi.restoreAllMocks()
    })

    it('#then does not pause when skew is exactly at threshold', async () => {
      // #given
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Test' })
      })

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockReturnValue({
        pushItem: {
          id: 'task-1',
          type: 'task',
          operation: 'create',
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1'
        },
        sizeBytes: 100
      })

      const boundaryServerTime = Math.floor(Date.now() / 1000) + 300
      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['task-1'],
        rejected: [],
        serverTime: boundaryServerTime
      })

      // #when
      await engine.push()

      // #then — skew == threshold, should NOT trigger (uses > not >=)
      const clockSkewCalls = (deps.emitToRenderer as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[0] === 'sync:clock-skew-warning'
      )
      expect(clockSkewCalls).toHaveLength(0)

      const pausedCalls = (deps.emitToRenderer as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[0] === 'sync:paused'
      )
      expect(pausedCalls).toHaveLength(0)

      vi.restoreAllMocks()
    })

    it('#then does not emit when no skew', async () => {
      // #given
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Test' })
      })

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockReturnValue({
        pushItem: {
          id: 'task-1',
          type: 'task',
          operation: 'create',
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1'
        },
        sizeBytes: 100
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['task-1'],
        rejected: [],
        serverTime: Math.floor(Date.now() / 1000)
      })

      // #when
      await engine.push()

      // #then
      const clockSkewCalls = (deps.emitToRenderer as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[0] === 'sync:clock-skew-warning'
      )
      expect(clockSkewCalls).toHaveLength(0)

      vi.restoreAllMocks()
    })
  })

  describe('#given applier returns conflict #when pull receives item', () => {
    it('#then emits CONFLICT_DETECTED event', async () => {
      // #given
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      const mockChanges = {
        items: [{ id: 'task-1', type: 'task', version: 1, modifiedAt: 1000, size: 50 }],
        deleted: [],
        hasMore: false,
        nextCursor: 1
      }
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue(mockChanges)

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        items: [
          {
            id: 'task-1',
            type: 'task',
            operation: 'update',
            cryptoVersion: 1,
            blob: {
              encryptedKey: 'ek',
              keyNonce: 'kn',
              encryptedData: 'ed',
              dataNonce: 'dn'
            },
            signature: 'sig',
            signerDeviceId: 'device-1',
            clock: { 'device-1': 2 }
          }
        ]
      })

      vi.spyOn(await import('./decrypt'), 'decryptItemFromPull').mockReturnValue({
        content: new TextEncoder().encode(
          JSON.stringify({ id: 'task-1', title: 'Remote', clock: { 'device-1': 2 } })
        ),
        verified: true
      })

      // #when — mock the applier to return 'conflict'
      const { ItemApplier } = await import('./apply-item')
      vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('conflict')

      await engine.pull()

      // #then
      expect(deps.emitToRenderer).toHaveBeenCalledWith(
        'sync:conflict-detected',
        expect.objectContaining({ itemId: 'task-1', type: 'task' })
      )

      vi.restoreAllMocks()
    })
  })

  describe('#given pull response contains tombstone #when item applied', () => {
    it('#then applies delete operation', async () => {
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: ['task-1'],
        hasMore: false,
        nextCursor: 1
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        items: [
          {
            id: 'task-1',
            type: 'task',
            operation: 'delete',
            cryptoVersion: 1,
            blob: {
              encryptedKey: 'ek',
              keyNonce: 'kn',
              encryptedData: 'ed',
              dataNonce: 'dn'
            },
            signature: 'sig',
            signerDeviceId: 'device-1',
            deletedAt: 1700000000,
            clock: { 'device-1': 2 }
          }
        ]
      })

      vi.spyOn(await import('./decrypt'), 'decryptItemFromPull').mockReturnValue({
        content: new TextEncoder().encode(JSON.stringify({ id: 'task-1' })),
        verified: true
      })

      const { ItemApplier } = await import('./apply-item')
      const applySpy = vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('applied')

      await engine.pull()

      expect(applySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: 'task-1',
          type: 'task',
          operation: 'delete'
        })
      )
      vi.restoreAllMocks()
    })
  })

  describe('#given full push/pull round-trip #when item queued and synced', () => {
    it('#then item is encrypted, pushed, pulled, decrypted, and applied', async () => {
      // #given
      const deps = createMockDeps(testDb)
      const taskPayload = { id: 'task-1', title: 'Round trip test', projectId: 'proj-1' }
      const encodedPayload = new TextEncoder().encode(JSON.stringify(taskPayload))

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'create',
        payload: JSON.stringify(taskPayload)
      })

      const fakePushItem = {
        id: 'task-1',
        type: 'task' as const,
        operation: 'create' as const,
        encryptedKey: 'ek-base64',
        keyNonce: 'kn-base64',
        encryptedData: 'ed-base64',
        dataNonce: 'dn-base64',
        signature: 'sig-base64',
        signerDeviceId: 'device-1'
      }

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockReturnValue({
        pushItem: fakePushItem,
        sizeBytes: 128
      })

      const serverTime = Math.floor(Date.now() / 1000)
      const postMock = vi.fn()
      const getMock = vi.fn()

      postMock
        .mockResolvedValueOnce({
          accepted: ['task-1'],
          rejected: [],
          serverTime
        })
        .mockResolvedValueOnce({
          items: [
            {
              id: 'task-1',
              type: 'task',
              operation: 'create',
              cryptoVersion: 1,
              blob: {
                encryptedKey: 'ek-base64',
                keyNonce: 'kn-base64',
                encryptedData: 'ed-base64',
                dataNonce: 'dn-base64'
              },
              signature: 'sig-base64',
              signerDeviceId: 'device-1',
              clock: { 'device-1': 1 }
            }
          ]
        })

      getMock.mockResolvedValue({
        items: [{ id: 'task-1', type: 'task', version: 1, modifiedAt: 1000, size: 128 }],
        deleted: [],
        hasMore: false,
        nextCursor: 1
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockImplementation(postMock)
      vi.spyOn(await import('./http-client'), 'getFromServer').mockImplementation(getMock)

      vi.spyOn(await import('./decrypt'), 'decryptItemFromPull').mockReturnValue({
        content: encodedPayload,
        verified: true
      })

      const { ItemApplier } = await import('./apply-item')
      const applySpy = vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('applied')

      // #when — push then pull
      const engine = new SyncEngine(deps)
      await engine.push()
      await engine.pull()

      // #then — encrypt was called for push
      const encryptMod = await import('./encrypt')
      expect(encryptMod.encryptItemForPush).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'task-1', type: 'task', operation: 'create' })
      )

      // push was accepted
      expect(deps.queue.getPendingCount()).toBe(0)

      // pull fetched changes and decrypted
      const decryptMod = await import('./decrypt')
      expect(decryptMod.decryptItemFromPull).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'task-1', type: 'task' })
      )

      // applier received the decrypted content
      expect(applySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: 'task-1',
          type: 'task',
          operation: 'create',
          content: encodedPayload
        })
      )

      // item-synced events for both push and pull
      const itemSyncedCalls = (deps.emitToRenderer as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[0] === 'sync:item-synced'
      )
      const pushEvents = itemSyncedCalls.filter((call) => call[1]?.operation === 'push')
      const pullEvents = itemSyncedCalls.filter((call) => call[1]?.operation === 'pull')
      expect(pushEvents).toHaveLength(1)
      expect(pullEvents).toHaveLength(1)

      vi.restoreAllMocks()
    })
  })

  describe('#given unregistered device on startup #when start() called', () => {
    it('#then sets idle state without connecting WS or syncing', async () => {
      const deps = createMockDeps(testDb, {
        getSigningKeys: vi.fn().mockResolvedValue(null)
      })
      const engine = new SyncEngine(deps)
      await engine.start()

      expect(engine.currentState).toBe('idle')
      expect(deps.ws.connect).not.toHaveBeenCalled()
      await engine.stop()
    })
  })

  describe('#given stale token but no device #when start() called', () => {
    it('#then does not connect despite token in keychain', async () => {
      const deps = createMockDeps(testDb, {
        getAccessToken: vi.fn().mockResolvedValue('stale-expired-token'),
        getSigningKeys: vi.fn().mockResolvedValue(null)
      })
      const engine = new SyncEngine(deps)
      await engine.start()

      expect(engine.currentState).toBe('idle')
      expect(deps.ws.connect).not.toHaveBeenCalled()
      await engine.stop()
    })
  })

  describe('#given unregistered device #when network comes back online', () => {
    it('#then does not reconnect WS or schedule sync', async () => {
      const network = createMockNetwork(false)
      const deps = createMockDeps(testDb, {
        network,
        getSigningKeys: vi.fn().mockResolvedValue(null)
      })
      const engine = new SyncEngine(deps)
      await engine.start()
      ;(network as unknown as { _online: boolean })._online = true
      network.emit('status-changed', { online: true })

      await new Promise((r) => setTimeout(r, 50))

      expect(deps.ws.connect).not.toHaveBeenCalled()
      await engine.stop()
    })
  })

  describe('#given device registered after start #when activate() called', () => {
    it('#then connects WS and starts sync', async () => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })

      const getSigningKeys = vi.fn().mockResolvedValue(null)
      const deps = createMockDeps(testDb, { getSigningKeys })
      const engine = new SyncEngine(deps)
      await engine.start()

      expect(deps.ws.connect).not.toHaveBeenCalled()

      getSigningKeys.mockResolvedValue({
        secretKey: new Uint8Array(64),
        publicKey: new Uint8Array(32),
        deviceId: 'device-1'
      })
      await engine.activate()

      expect(deps.ws.connect).toHaveBeenCalled()
      await engine.stop()
      vi.restoreAllMocks()
    })
  })

  describe('#given activate() with no device #when called', () => {
    it('#then returns early without connecting', async () => {
      const deps = createMockDeps(testDb, {
        getSigningKeys: vi.fn().mockResolvedValue(null)
      })
      const engine = new SyncEngine(deps)
      await engine.start()
      await engine.activate()

      expect(deps.ws.connect).not.toHaveBeenCalled()
      await engine.stop()
    })
  })

  describe('#given fullSync #when signing keys available', () => {
    it('#then calls runInitialSeed between pull and push', async () => {
      // #given
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })

      const initialSeedModule = await import('./initial-seed')
      const seedSpy = vi.spyOn(initialSeedModule, 'runInitialSeed').mockImplementation(() => {})

      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      // #when
      await engine.fullSync()

      // #then
      expect(seedSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          db: deps.db,
          queue: deps.queue,
          deviceId: 'device-1'
        })
      )

      vi.restoreAllMocks()
    })
  })

  describe('#given fullSync #when no signing keys', () => {
    it('#then skips runInitialSeed', async () => {
      // #given
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })

      const initialSeedModule = await import('./initial-seed')
      const seedSpy = vi.spyOn(initialSeedModule, 'runInitialSeed').mockImplementation(() => {})

      const deps = createMockDeps(testDb, {
        getSigningKeys: vi.fn().mockResolvedValue(null)
      })
      const engine = new SyncEngine(deps)

      // #when
      await engine.fullSync()

      // #then
      expect(seedSpy).not.toHaveBeenCalled()

      vi.restoreAllMocks()
    })
  })

  describe('#given fullSync #when manifest check re-enqueues items', () => {
    it('#then runs a follow-up push in the same cycle', async () => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })

      const manifestModule = await import('./manifest-check')
      vi.spyOn(manifestModule, 'checkManifestIntegrity').mockImplementation(async ({ queue }) => {
        queue.enqueue({
          type: 'task',
          itemId: 'task-missing',
          operation: 'create',
          payload: JSON.stringify({
            id: 'task-missing',
            title: 'Recovered task',
            projectId: 'proj-1',
            priority: 0,
            position: 0,
            clock: { 'device-1': 1 }
          })
        })
        return { checkedAt: Date.now(), rePullNeeded: false, serverOnlyCount: 0 }
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['task-missing'],
        rejected: [],
        serverTime: Date.now()
      })

      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)
      const origPush = engine.push.bind(engine)
      let pushCallCount = 0
      engine.push = async () => {
        pushCallCount++
        return origPush()
      }

      await engine.fullSync()

      expect(pushCallCount).toBe(2)
      expect(deps.queue.getPendingCount()).toBe(0)
      vi.restoreAllMocks()
    })
  })

  describe('#given fullSync race condition #when WS connected fires mid-sync', () => {
    it('#then push still executes (not blocked by WS-triggered pull)', async () => {
      // #given
      const getFromServerSpy = vi
        .spyOn(await import('./http-client'), 'getFromServer')
        .mockResolvedValue({
          items: [],
          deleted: [],
          hasMore: false,
          nextCursor: 0
        })

      const initialSeedModule = await import('./initial-seed')
      vi.spyOn(initialSeedModule, 'runInitialSeed').mockImplementation(() => {})

      const manifestModule = await import('./manifest-check')
      vi.spyOn(manifestModule, 'checkManifestIntegrity').mockResolvedValue({
        checkedAt: Date.now(),
        rePullNeeded: false,
        serverOnlyCount: 0
      })

      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)
      await engine.start()

      // After start(), fullSync completed. Clear call counts.
      getFromServerSpy.mockClear()

      // Monkey-patch push to track whether it actually executes its body
      let pushBodyExecuted = false
      const origPush = engine.push.bind(engine)
      engine.push = async () => {
        pushBodyExecuted = true
        return origPush()
      }

      // #when — call fullSync again (simulates activate/reconnect)
      await engine.fullSync()

      // #then — push body was reached (not short-circuited by syncing lock)
      expect(pushBodyExecuted).toBe(true)

      await engine.stop()
      vi.restoreAllMocks()
    })
  })

  describe('#given fullSync active #when scheduleSync called', () => {
    it('#then WS connected event does not trigger additional pull', async () => {
      // #given
      const getFromServerSpy = vi
        .spyOn(await import('./http-client'), 'getFromServer')
        .mockResolvedValue({
          items: [],
          deleted: [],
          hasMore: false,
          nextCursor: 0
        })

      const initialSeedModule = await import('./initial-seed')
      vi.spyOn(initialSeedModule, 'runInitialSeed').mockImplementation(() => {})

      const manifestModule = await import('./manifest-check')
      vi.spyOn(manifestModule, 'checkManifestIntegrity').mockResolvedValue({
        checkedAt: Date.now(),
        rePullNeeded: false,
        serverOnlyCount: 0
      })

      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)
      await engine.start()

      // After start(), initial fullSync completed. Clear counts.
      getFromServerSpy.mockClear()

      // Monkey-patch fullSync to emit 'connected' during its execution
      const origFullSync = engine.fullSync.bind(engine)
      engine.fullSync = async () => {
        const promise = origFullSync()
        // Emit connected during fullSync — should be no-op due to fullSyncActive guard
        deps.ws.emit('connected')
        return promise
      }

      // #when — trigger fullSync via explicit call
      await engine.fullSync()

      // #then — getFromServer called once (fullSync's pull), not twice
      expect(getFromServerSpy).toHaveBeenCalledTimes(1)

      await engine.stop()
      vi.restoreAllMocks()
    })
  })

  describe('#given engine #when requestPush called multiple times rapidly', () => {
    it('#then debounces into single push', async () => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })

      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      let pushCallCount = 0
      const origPush = engine.push.bind(engine)
      engine.push = async () => {
        pushCallCount++
        return origPush()
      }

      engine.requestPush()
      engine.requestPush()
      engine.requestPush()
      engine.requestPush()
      engine.requestPush()

      await vi.waitFor(
        () => {
          expect(pushCallCount).toBe(1)
        },
        { timeout: 5000 }
      )

      await engine.stop()
      vi.restoreAllMocks()
    })
  })

  describe('#given paused engine #when requestPush called', () => {
    it('#then does not schedule push', async () => {
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)
      engine.pause()

      let pushCallCount = 0
      const origPush = engine.push.bind(engine)
      engine.push = async () => {
        pushCallCount++
        return origPush()
      }

      engine.requestPush()

      await new Promise((r) => setTimeout(r, 3000))

      expect(pushCallCount).toBe(0)
      await engine.stop()
    })
  })

  describe('#given fullSync active #when requestPush called', () => {
    it('#then does not schedule push', async () => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })

      const initialSeedModule = await import('./initial-seed')
      vi.spyOn(initialSeedModule, 'runInitialSeed').mockImplementation(() => {})

      const manifestModule = await import('./manifest-check')
      vi.spyOn(manifestModule, 'checkManifestIntegrity').mockResolvedValue({
        checkedAt: Date.now(),
        rePullNeeded: false,
        serverOnlyCount: 0
      })

      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      let pushCallCount = 0
      const origPush = engine.push.bind(engine)
      const origFullSync = engine.fullSync.bind(engine)

      engine.push = async () => {
        pushCallCount++
        return origPush()
      }

      engine.fullSync = async () => {
        engine.requestPush()
        return origFullSync()
      }

      pushCallCount = 0
      await engine.fullSync()

      expect(pushCallCount).toBe(1)

      await engine.stop()
      vi.restoreAllMocks()
    })
  })

  describe('#given queue #when item enqueued with callback set', () => {
    it('#then fires onItemEnqueued callback', () => {
      const deps = createMockDeps(testDb)
      const callback = vi.fn()
      deps.queue.setOnItemEnqueued(callback)

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'create',
        payload: '{}'
      })

      expect(callback).toHaveBeenCalledTimes(1)
    })
  })

  describe('#given WS reconnect #when handleWsConnected fires', () => {
    it('#then schedules pull and catches up open CRDT notes', async () => {
      const getServerMock = vi.fn().mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })
      vi.spyOn(await import('./http-client'), 'getFromServer').mockImplementation(getServerMock)

      const deps = createMockDeps(testDb, {
        crdtProvider: {
          getOpenNoteIds: vi.fn().mockReturnValue(['note-1', 'note-2'])
        } as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)
      await engine.start()

      getServerMock.mockClear()

      const pullCrdtForNote = vi.fn().mockResolvedValue(undefined)
      ;(engine as unknown as { crdtSync: { pullCrdtForNote: typeof pullCrdtForNote } }).crdtSync = {
        pullCrdtForNote
      }

      const pullDone = new Promise<void>((resolve) => {
        pullCrdtForNote.mockImplementation(async (noteId: string) => {
          if (noteId === 'note-2') {
            resolve()
          }
        })
      })

      deps.ws.emit('connected')

      await pullDone
      expect(getServerMock).toHaveBeenCalled()
      expect(pullCrdtForNote).toHaveBeenCalledTimes(2)
      expect(pullCrdtForNote).toHaveBeenCalledWith('note-1')
      expect(pullCrdtForNote).toHaveBeenCalledWith('note-2')

      await engine.stop()
      vi.restoreAllMocks()
    })
  })

  describe('#given pull with unknown signer device #when pull called', () => {
    it('#then skips unknown signer items but continues pagination', async () => {
      const deps = createMockDeps(testDb, {
        getDevicePublicKey: vi.fn().mockImplementation(async (deviceId: string) => {
          if (deviceId === 'device-1') return new Uint8Array(32)
          return null
        })
      })
      const engine = new SyncEngine(deps)

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [
          { id: 'task-1', type: 'task', version: 1, modifiedAt: 1000, size: 10 },
          { id: 'task-2', type: 'task', version: 1, modifiedAt: 1001, size: 10 }
        ],
        deleted: [],
        hasMore: false,
        nextCursor: 2
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        items: [
          {
            id: 'task-1',
            type: 'task',
            operation: 'create',
            cryptoVersion: 1,
            blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
            signature: 'sig',
            signerDeviceId: 'device-unknown'
          },
          {
            id: 'task-2',
            type: 'task',
            operation: 'create',
            cryptoVersion: 1,
            blob: { encryptedKey: 'ek2', keyNonce: 'kn2', encryptedData: 'ed2', dataNonce: 'dn2' },
            signature: 'sig2',
            signerDeviceId: 'device-1'
          }
        ]
      })

      vi.spyOn(await import('./decrypt'), 'decryptItemFromPull').mockReturnValue({
        content: new TextEncoder().encode(JSON.stringify({ id: 'task-2' })),
        verified: true
      })

      const { ItemApplier } = await import('./apply-item')
      const applySpy = vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('applied')

      await engine.pull()

      expect(applySpy).toHaveBeenCalledTimes(1)
      expect(applySpy).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'task-2' }))

      vi.restoreAllMocks()
    })
  })

  describe('#given pull with one bad item #when decrypt throws for first item', () => {
    it('#then still applies remaining items', async () => {
      // #given
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [
          { id: 'task-1', type: 'task', version: 1, modifiedAt: 1000, size: 10 },
          { id: 'task-2', type: 'task', version: 1, modifiedAt: 1001, size: 10 }
        ],
        deleted: [],
        hasMore: false,
        nextCursor: 2
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        items: [
          {
            id: 'task-1',
            type: 'task',
            operation: 'create',
            cryptoVersion: 1,
            blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
            signature: 'sig',
            signerDeviceId: 'device-1',
            clock: { 'device-1': 1 }
          },
          {
            id: 'task-2',
            type: 'task',
            operation: 'create',
            cryptoVersion: 1,
            blob: { encryptedKey: 'ek2', keyNonce: 'kn2', encryptedData: 'ed2', dataNonce: 'dn2' },
            signature: 'sig2',
            signerDeviceId: 'device-1',
            clock: { 'device-1': 2 }
          }
        ]
      })

      const decryptMock = vi.spyOn(await import('./decrypt'), 'decryptItemFromPull')
      decryptMock.mockImplementationOnce(() => {
        throw new Error('base64 decode failed')
      })
      decryptMock.mockReturnValueOnce({
        content: new TextEncoder().encode(JSON.stringify({ id: 'task-2', title: 'Good' })),
        verified: true
      })

      const { ItemApplier } = await import('./apply-item')
      const applySpy = vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('applied')

      // #when
      await engine.pull()

      // #then — item-2 applied despite item-1 failing
      expect(applySpy).toHaveBeenCalledTimes(1)
      expect(applySpy).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'task-2' }))
      expect(engine.currentState).not.toBe('error')

      vi.restoreAllMocks()
    })
  })

  describe('#given pull with all crypto failures #when every item throws SignatureVerificationError', () => {
    it('#then quarantines items instead of tripping circuit breaker', async () => {
      // #given
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [
          { id: 'task-1', type: 'task', version: 1, modifiedAt: 1000, size: 10 },
          { id: 'task-2', type: 'task', version: 1, modifiedAt: 1001, size: 10 }
        ],
        deleted: [],
        hasMore: false,
        nextCursor: 2
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        items: [
          {
            id: 'task-1',
            type: 'task',
            operation: 'create',
            cryptoVersion: 1,
            blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
            signature: 'sig',
            signerDeviceId: 'device-1',
            clock: { 'device-1': 1 }
          },
          {
            id: 'task-2',
            type: 'task',
            operation: 'create',
            cryptoVersion: 1,
            blob: { encryptedKey: 'ek2', keyNonce: 'kn2', encryptedData: 'ed2', dataNonce: 'dn2' },
            signature: 'sig2',
            signerDeviceId: 'device-1',
            clock: { 'device-1': 2 }
          }
        ]
      })

      const { SignatureVerificationError } = await import('./decrypt')
      vi.spyOn(await import('./decrypt'), 'decryptItemFromPull').mockImplementation((input) => {
        throw new SignatureVerificationError(input.id, input.signerDeviceId)
      })

      // #when
      await engine.pull()

      // #then — items are quarantined, circuit breaker does NOT trip
      expect(engine.currentState).not.toBe('error')
      const quarantined = engine.getQuarantinedItems()
      expect(quarantined).toHaveLength(2)
      expect(quarantined[0].signerDeviceId).toBe('device-1')
      expect(quarantined[0].attemptCount).toBe(1)
      expect(quarantined[0].permanent).toBe(false)

      // security warning emitted to renderer
      expect(deps.emitToRenderer).toHaveBeenCalledWith(
        'sync:security-warning',
        expect.objectContaining({
          reason: 'signature_verification_failed',
          itemId: expect.any(String),
          signerDeviceId: 'device-1'
        })
      )

      vi.restoreAllMocks()
    })

    it('#then permanently quarantines after 3 failures', async () => {
      // #given
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      const makeServerMocks = async () => {
        vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
          items: [{ id: 'task-1', type: 'task', version: 1, modifiedAt: 1000, size: 10 }],
          deleted: [],
          hasMore: false,
          nextCursor: 2
        })

        vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
          items: [
            {
              id: 'task-1',
              type: 'task',
              operation: 'create',
              cryptoVersion: 1,
              blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
              signature: 'sig',
              signerDeviceId: 'device-1',
              clock: { 'device-1': 1 }
            }
          ]
        })

        const { SignatureVerificationError } = await import('./decrypt')
        vi.spyOn(await import('./decrypt'), 'decryptItemFromPull').mockImplementation((input) => {
          throw new SignatureVerificationError(input.id, input.signerDeviceId)
        })
      }

      // #when — pull 3 times
      await makeServerMocks()
      await engine.pull()
      vi.restoreAllMocks()

      await makeServerMocks()
      await engine.pull()
      vi.restoreAllMocks()

      await makeServerMocks()
      await engine.pull()
      vi.restoreAllMocks()

      // #then — permanently quarantined after 3 attempts
      const quarantined = engine.getQuarantinedItems()
      expect(quarantined).toHaveLength(1)
      expect(quarantined[0].attemptCount).toBe(3)
      expect(quarantined[0].permanent).toBe(true)

      // #when — 4th pull: item is skipped entirely (permanently quarantined)
      await makeServerMocks()
      await engine.pull()
      vi.restoreAllMocks()

      const q2 = engine.getQuarantinedItems()
      expect(q2[0].attemptCount).toBe(3)
    })
  })

  describe('#given manifest detects server-only items #when fullSync runs', () => {
    it('#then resets cursor and re-pulls', async () => {
      // #given
      const getServerMock = vi.fn().mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })
      vi.spyOn(await import('./http-client'), 'getFromServer').mockImplementation(getServerMock)

      const manifestModule = await import('./manifest-check')
      vi.spyOn(manifestModule, 'checkManifestIntegrity').mockResolvedValue({
        checkedAt: Date.now(),
        rePullNeeded: true,
        serverOnlyCount: 3
      })

      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      const origPull = engine.pull.bind(engine)
      let pullCallCount = 0
      engine.pull = async () => {
        pullCallCount++
        return origPull()
      }

      // #when
      await engine.fullSync()

      // #then — pull called twice: initial + re-pull after manifest
      expect(pullCallCount).toBe(2)

      vi.restoreAllMocks()
    })
  })

  describe('#given SYNC_REPLAY_DETECTED rejection #when push processes response', () => {
    it('#then treats replay as success and removes from queue', async () => {
      // #given
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'update',
        payload: JSON.stringify({ title: 'Stale', clock: { 'device-1': 1 } })
      })

      const markSuccessSpy = vi.spyOn(deps.queue, 'markSuccess')
      const markFailedSpy = vi.spyOn(deps.queue, 'markFailed')

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockImplementation((input) => ({
        pushItem: {
          id: input.id,
          type: input.type,
          operation: input.operation,
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1'
        },
        sizeBytes: 100
      }))

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: [],
        rejected: [{ id: 'task-1', reason: 'SYNC_REPLAY_DETECTED' }],
        serverTime: Math.floor(Date.now() / 1000)
      })

      // #when
      await engine.push()

      // #then — replay treated as success, not failure
      expect(markSuccessSpy).toHaveBeenCalled()
      expect(markFailedSpy).not.toHaveBeenCalled()
      expect(deps.queue.getPendingCount()).toBe(0)

      vi.restoreAllMocks()
    })
  })

  describe('#given duplicate queue items for same itemId #when push called', () => {
    it('#then deduplicates and marks extras as success', async () => {
      // #given — two queue entries for same item (simulating failed retry + re-enqueue)
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      const id1 = deps.queue.enqueue({
        type: 'task',
        itemId: 'task-dup',
        operation: 'update',
        payload: JSON.stringify({ title: 'V1', clock: { 'device-1': 1 } })
      })

      // Simulate first item having been attempted (so dedup in enqueue doesn't collapse)
      deps.queue.dequeue(1)
      deps.queue.markFailed(id1, 'network error')

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-dup',
        operation: 'update',
        payload: JSON.stringify({ title: 'V2', clock: { 'device-1': 2 } })
      })

      const markSuccessSpy = vi.spyOn(deps.queue, 'markSuccess')

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockImplementation((input) => ({
        pushItem: {
          id: input.id,
          type: input.type,
          operation: input.operation,
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1'
        },
        sizeBytes: 100
      }))

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['task-dup'],
        rejected: [],
        serverTime: Math.floor(Date.now() / 1000)
      })

      // #when
      await engine.push()

      // #then — one item deduped (markSuccess), one pushed and accepted (markSuccess)
      expect(markSuccessSpy).toHaveBeenCalledTimes(2)
      expect(deps.queue.getPendingCount()).toBe(0)

      vi.restoreAllMocks()
    })
  })

  describe('#given handler with buildPushPayload #when push called for upsert', () => {
    it('#then uses fresh payload instead of frozen queue payload', async () => {
      // #given
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-fresh',
        operation: 'update',
        payload: JSON.stringify({ title: 'Stale content', clock: { 'device-1': 1 } })
      })

      const freshPayload = JSON.stringify({
        title: 'Fresh content',
        clock: { 'device-1': 3 }
      })

      const mockHandler = {
        type: 'task' as const,
        schema: {} as never,
        applyUpsert: vi.fn(),
        applyDelete: vi.fn(),
        fetchLocal: vi.fn(),
        seedUnclocked: vi.fn(),
        buildPushPayload: vi.fn().mockReturnValue(freshPayload)
      }

      vi.spyOn(await import('./item-handlers'), 'getHandler').mockReturnValue(mockHandler)

      let capturedContent: string | undefined
      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockImplementation((input) => {
        capturedContent = new TextDecoder().decode(input.content)
        return {
          pushItem: {
            id: input.id,
            type: input.type,
            operation: input.operation,
            encryptedKey: 'ek',
            keyNonce: 'kn',
            encryptedData: 'ed',
            dataNonce: 'dn',
            signature: 'sig',
            signerDeviceId: 'device-1'
          },
          sizeBytes: 100
        }
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['task-fresh'],
        rejected: [],
        serverTime: Math.floor(Date.now() / 1000)
      })

      // #when
      await engine.push()

      // #then — encryptItemForPush received fresh payload, not stale
      expect(mockHandler.buildPushPayload).toHaveBeenCalledWith(
        deps.db,
        'task-fresh',
        'device-1',
        'update'
      )
      expect(capturedContent).toBe(freshPayload)

      vi.restoreAllMocks()
    })

    it('#then falls back to frozen payload for delete operations', async () => {
      // #given
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      const frozenPayload = JSON.stringify({ title: 'Deleted note', clock: { 'device-1': 1 } })
      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-del',
        operation: 'delete',
        payload: frozenPayload
      })

      const mockHandler = {
        type: 'task' as const,
        schema: {} as never,
        applyUpsert: vi.fn(),
        applyDelete: vi.fn(),
        fetchLocal: vi.fn(),
        seedUnclocked: vi.fn(),
        buildPushPayload: vi.fn()
      }

      vi.spyOn(await import('./item-handlers'), 'getHandler').mockReturnValue(mockHandler)

      let capturedContent: string | undefined
      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockImplementation((input) => {
        capturedContent = new TextDecoder().decode(input.content)
        return {
          pushItem: {
            id: input.id,
            type: input.type,
            operation: input.operation,
            encryptedKey: 'ek',
            keyNonce: 'kn',
            encryptedData: 'ed',
            dataNonce: 'dn',
            signature: 'sig',
            signerDeviceId: 'device-1'
          },
          sizeBytes: 100
        }
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['task-del'],
        rejected: [],
        serverTime: Math.floor(Date.now() / 1000)
      })

      // #when
      await engine.push()

      // #then — delete uses frozen payload, buildPushPayload NOT called
      expect(mockHandler.buildPushPayload).not.toHaveBeenCalled()
      expect(capturedContent).toBe(frozenPayload)

      vi.restoreAllMocks()
    })
  })

  describe('#given engine with crdtProvider and CREATE note queued #when push called', () => {
    it('#then pushes CRDT snapshot BEFORE posting sync items to server', async () => {
      // #given
      const callOrder: string[] = []

      const mockCrdtProvider = {
        pushSnapshotForNote: vi.fn().mockImplementation(async () => {
          callOrder.push('pushSnapshot')
          return true
        })
      }

      const deps = createMockDeps(testDb, {
        crdtProvider: mockCrdtProvider as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'note',
        itemId: 'note-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Test Note' })
      })

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockReturnValue({
        pushItem: {
          id: 'note-1',
          type: 'note',
          operation: 'create',
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1'
        },
        sizeBytes: 100
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockImplementation(async () => {
        callOrder.push('postToServer')
        return {
          accepted: ['note-1'],
          rejected: [],
          serverTime: Math.floor(Date.now() / 1000),
          maxCursor: 1
        }
      })

      // #when
      await engine.push()

      // #then
      expect(mockCrdtProvider.pushSnapshotForNote).toHaveBeenCalledWith('note-1')
      expect(callOrder).toEqual(['pushSnapshot', 'postToServer'])

      vi.restoreAllMocks()
    })

    it('#then pushes CRDT snapshot for journal CREATE items too', async () => {
      // #given
      const mockCrdtProvider = {
        pushSnapshotForNote: vi.fn().mockResolvedValue(true)
      }

      const deps = createMockDeps(testDb, {
        crdtProvider: mockCrdtProvider as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'journal',
        itemId: 'journal-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Daily Entry' })
      })

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockReturnValue({
        pushItem: {
          id: 'journal-1',
          type: 'journal',
          operation: 'create',
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1'
        },
        sizeBytes: 100
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['journal-1'],
        rejected: [],
        serverTime: Math.floor(Date.now() / 1000),
        maxCursor: 1
      })

      // #when
      await engine.push()

      // #then
      expect(mockCrdtProvider.pushSnapshotForNote).toHaveBeenCalledWith('journal-1')

      vi.restoreAllMocks()
    })
  })

  describe('#given engine with crdtProvider and UPDATE note queued #when push called', () => {
    it('#then does NOT push CRDT snapshot (only CREATEs trigger snapshot)', async () => {
      // #given
      const mockCrdtProvider = {
        pushSnapshotForNote: vi.fn().mockResolvedValue(true)
      }

      const deps = createMockDeps(testDb, {
        crdtProvider: mockCrdtProvider as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'note',
        itemId: 'note-1',
        operation: 'update',
        payload: JSON.stringify({ title: 'Updated' })
      })

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockReturnValue({
        pushItem: {
          id: 'note-1',
          type: 'note',
          operation: 'update',
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1'
        },
        sizeBytes: 100
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['note-1'],
        rejected: [],
        serverTime: Math.floor(Date.now() / 1000),
        maxCursor: 1
      })

      // #when
      await engine.push()

      // #then
      expect(mockCrdtProvider.pushSnapshotForNote).not.toHaveBeenCalled()

      vi.restoreAllMocks()
    })
  })

  describe('#given engine with crdtProvider and CREATE task queued #when push called', () => {
    it('#then does NOT push CRDT snapshot (only note/journal types trigger snapshot)', async () => {
      // #given
      const mockCrdtProvider = {
        pushSnapshotForNote: vi.fn().mockResolvedValue(true)
      }

      const deps = createMockDeps(testDb, {
        crdtProvider: mockCrdtProvider as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'New Task' })
      })

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockReturnValue({
        pushItem: {
          id: 'task-1',
          type: 'task',
          operation: 'create',
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1'
        },
        sizeBytes: 100
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['task-1'],
        rejected: [],
        serverTime: Math.floor(Date.now() / 1000),
        maxCursor: 1
      })

      // #when
      await engine.push()

      // #then
      expect(mockCrdtProvider.pushSnapshotForNote).not.toHaveBeenCalled()

      vi.restoreAllMocks()
    })
  })

  describe('#given engine with crdtProvider where snapshot push fails #when push called', () => {
    it('#then still posts sync items to server (snapshot failure is non-blocking)', async () => {
      // #given
      const mockCrdtProvider = {
        pushSnapshotForNote: vi.fn().mockRejectedValue(new Error('network timeout'))
      }

      const deps = createMockDeps(testDb, {
        crdtProvider: mockCrdtProvider as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'note',
        itemId: 'note-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Test' })
      })

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockReturnValue({
        pushItem: {
          id: 'note-1',
          type: 'note',
          operation: 'create',
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1'
        },
        sizeBytes: 100
      })

      const mockPost = vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['note-1'],
        rejected: [],
        serverTime: Math.floor(Date.now() / 1000),
        maxCursor: 1
      })

      // #when
      await engine.push()

      // #then
      expect(mockCrdtProvider.pushSnapshotForNote).toHaveBeenCalledWith('note-1')
      expect(mockPost).toHaveBeenCalled()
      expect(deps.queue.getPendingCount()).toBe(0)

      vi.restoreAllMocks()
    })
  })

  describe('#given engine with crdtProvider and mixed batch #when push called', () => {
    it('#then only pushes CRDT snapshots for CREATE note/journal items in batch', async () => {
      // #given
      const mockCrdtProvider = {
        pushSnapshotForNote: vi.fn().mockResolvedValue(true)
      }

      const deps = createMockDeps(testDb, {
        crdtProvider: mockCrdtProvider as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'note',
        itemId: 'note-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'New Note' })
      })
      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'New Task' })
      })
      deps.queue.enqueue({
        type: 'note',
        itemId: 'note-2',
        operation: 'update',
        payload: JSON.stringify({ title: 'Updated Note' })
      })
      deps.queue.enqueue({
        type: 'journal',
        itemId: 'journal-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Entry' })
      })

      let encryptCallCount = 0
      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockImplementation(
        (args: { id: string; type: string; operation: string }) => {
          encryptCallCount++
          return {
            pushItem: {
              id: args.id,
              type: args.type,
              operation: args.operation,
              encryptedKey: 'ek',
              keyNonce: 'kn',
              encryptedData: 'ed',
              dataNonce: 'dn',
              signature: 'sig',
              signerDeviceId: 'device-1'
            },
            sizeBytes: 100
          }
        }
      )

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['note-1', 'task-1', 'note-2', 'journal-1'],
        rejected: [],
        serverTime: Math.floor(Date.now() / 1000),
        maxCursor: 1
      })

      // #when
      await engine.push()

      // #then — only CREATE note + CREATE journal get snapshot pushes
      expect(mockCrdtProvider.pushSnapshotForNote).toHaveBeenCalledTimes(2)
      expect(mockCrdtProvider.pushSnapshotForNote).toHaveBeenCalledWith('note-1')
      expect(mockCrdtProvider.pushSnapshotForNote).toHaveBeenCalledWith('journal-1')

      vi.restoreAllMocks()
    })
  })

  describe('#given engine with pending items #when stop() called', () => {
    it('#then attempts final push before teardown', async () => {
      // #given
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-shutdown',
        operation: 'update',
        payload: JSON.stringify({ title: 'Pending', clock: { 'device-1': 1 } })
      })

      const pushSpy = vi.spyOn(engine, 'push').mockResolvedValue()

      // #when
      await engine.stop()

      // #then
      expect(pushSpy).toHaveBeenCalledTimes(1)
      expect(engine.currentState).toBe('idle')

      vi.restoreAllMocks()
    })

    it('#then skips final push when skipFinalPush option is set', async () => {
      // #given
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-skip',
        operation: 'update',
        payload: JSON.stringify({ title: 'Skipped', clock: { 'device-1': 1 } })
      })

      const pushSpy = vi.spyOn(engine, 'push').mockResolvedValue()

      // #when
      await engine.stop({ skipFinalPush: true })

      // #then
      expect(pushSpy).not.toHaveBeenCalled()

      vi.restoreAllMocks()
    })

    it('#then skips final push when offline', async () => {
      // #given
      const network = createMockNetwork(false)
      const deps = createMockDeps(testDb, { network })
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-offline',
        operation: 'update',
        payload: JSON.stringify({ title: 'Offline', clock: { 'device-1': 1 } })
      })

      const pushSpy = vi.spyOn(engine, 'push').mockResolvedValue()

      // #when
      await engine.stop()

      // #then
      expect(pushSpy).not.toHaveBeenCalled()

      vi.restoreAllMocks()
    })

    it('#then skips final push when queue is empty', async () => {
      // #given
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      const pushSpy = vi.spyOn(engine, 'push').mockResolvedValue()

      // #when
      await engine.stop()

      // #then
      expect(pushSpy).not.toHaveBeenCalled()

      vi.restoreAllMocks()
    })

    it('#then completes teardown even if final push throws', async () => {
      // #given
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-fail',
        operation: 'update',
        payload: JSON.stringify({ title: 'Fail', clock: { 'device-1': 1 } })
      })

      vi.spyOn(engine, 'push').mockRejectedValue(new Error('push failed'))

      // #when
      await engine.stop()

      // #then — teardown still completed
      expect(engine.currentState).toBe('idle')

      vi.restoreAllMocks()
    })
  })

  describe('#given device revoked via WS error message', () => {
    it('#then sets error state, disconnects WS, emits DEVICE_REMOVED', async () => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)
      await engine.start()

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'create',
        payload: '{}'
      })

      deps.ws.emit('message', {
        type: 'error',
        payload: { code: 'AUTH_DEVICE_REVOKED' }
      } as WebSocketMessage)

      expect(engine.currentState).toBe('error')
      expect(deps.ws.disconnect).toHaveBeenCalled()
      expect(deps.emitToRenderer).toHaveBeenCalledWith(
        'sync:device-removed',
        expect.objectContaining({ unsyncedCount: 1 })
      )

      await engine.stop()
      vi.restoreAllMocks()
    })
  })

  describe('#given device revoked via WS close code 4004', () => {
    it('#then sets error state and emits DEVICE_REMOVED', async () => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)
      await engine.start()

      deps.ws.emit('device_revoked')

      expect(engine.currentState).toBe('error')
      expect(deps.emitToRenderer).toHaveBeenCalledWith(
        'sync:device-removed',
        expect.objectContaining({ unsyncedCount: expect.any(Number) })
      )

      await engine.stop()
      vi.restoreAllMocks()
    })
  })

  describe('#given push fails with 403 AUTH_DEVICE_REVOKED', () => {
    it('#then handles device revocation instead of generic error', async () => {
      const { SyncServerError } = await import('./http-client')
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Test' })
      })

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockReturnValue({
        pushItem: {
          id: 'task-1',
          type: 'task',
          operation: 'create',
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1'
        },
        sizeBytes: 100
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockRejectedValue(
        new SyncServerError('Forbidden', 403, 'AUTH_DEVICE_REVOKED: Device has been revoked')
      )

      await engine.push()

      expect(engine.currentState).toBe('error')
      expect(deps.ws.disconnect).toHaveBeenCalled()
      expect(deps.emitToRenderer).toHaveBeenCalledWith(
        'sync:device-removed',
        expect.objectContaining({ unsyncedCount: expect.any(Number) })
      )

      await engine.stop({ skipFinalPush: true })
      vi.restoreAllMocks()
    })
  })

  describe('#given pull fails with 403 AUTH_DEVICE_REVOKED', () => {
    it('#then handles device revocation instead of generic error', async () => {
      const { SyncServerError } = await import('./http-client')
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      vi.spyOn(await import('./http-client'), 'getFromServer').mockRejectedValue(
        new SyncServerError('Forbidden', 403, 'AUTH_DEVICE_REVOKED: Device has been revoked')
      )

      await engine.pull()

      expect(engine.currentState).toBe('error')
      expect(deps.ws.disconnect).toHaveBeenCalled()
      expect(deps.emitToRenderer).toHaveBeenCalledWith(
        'sync:device-removed',
        expect.objectContaining({ unsyncedCount: expect.any(Number) })
      )

      await engine.stop({ skipFinalPush: true })
      vi.restoreAllMocks()
    })
  })

  describe('#given device revoked #when engine is in error state', () => {
    it('#then does NOT schedule retry', async () => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })
      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)
      await engine.start()

      deps.ws.emit('message', {
        type: 'error',
        payload: { code: 'AUTH_DEVICE_REVOKED' }
      } as WebSocketMessage)

      expect(engine.currentState).toBe('error')

      const status = engine.getStatus()
      expect(status.errorCategory).toBe('device_revoked')

      await engine.stop()
      vi.restoreAllMocks()
    })
  })

  describe('Extended offline mode', () => {
    describe('#given engine online #when network goes offline', () => {
      it('#then sets offlineSince timestamp', async () => {
        vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
          items: [],
          deleted: [],
          hasMore: false,
          nextCursor: 0
        })
        const network = createMockNetwork(true)
        const deps = createMockDeps(testDb, { network })
        const engine = new SyncEngine(deps)
        await engine.start()

        const before = Date.now()
        ;(network as EventEmitter).emit('status-changed', { online: false })

        const status = engine.getStatus()
        expect(status.status).toBe('offline')
        expect(status.offlineSince).toBeGreaterThanOrEqual(before)
        expect(status.offlineSince).toBeLessThanOrEqual(Date.now())

        await engine.stop()
        vi.restoreAllMocks()
      })
    })

    describe('#given engine offline #when network comes back online', () => {
      it('#then clears offlineSince', async () => {
        vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
          items: [],
          deleted: [],
          hasMore: false,
          nextCursor: 0
        })
        const network = createMockNetwork(true)
        const deps = createMockDeps(testDb, { network })
        const engine = new SyncEngine(deps)
        await engine.start()
        ;(network as EventEmitter).emit('status-changed', { online: false })
        expect(engine.getStatus().offlineSince).toBeDefined()
        ;(network as EventEmitter).emit('status-changed', { online: true })

        await vi.waitFor(() => {
          expect(engine.getStatus().offlineSince).toBeUndefined()
        })

        await engine.stop()
        vi.restoreAllMocks()
      })
    })

    describe('#given engine online #when going offline', () => {
      it('#then stops periodic pull interval', async () => {
        vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
          items: [],
          deleted: [],
          hasMore: false,
          nextCursor: 0
        })
        const clearIntervalSpy = vi.spyOn(global, 'clearInterval')
        const network = createMockNetwork(true)
        const deps = createMockDeps(testDb, { network })
        const engine = new SyncEngine(deps)
        await engine.start()
        ;(network as EventEmitter).emit('status-changed', { online: false })

        expect(clearIntervalSpy).toHaveBeenCalled()

        await engine.stop()
        vi.restoreAllMocks()
      })
    })

    describe('#given engine offline #when coming back online', () => {
      it('#then restarts periodic pull interval', async () => {
        vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
          items: [],
          deleted: [],
          hasMore: false,
          nextCursor: 0
        })
        const setIntervalSpy = vi.spyOn(global, 'setInterval')
        const network = createMockNetwork(true)
        const deps = createMockDeps(testDb, { network })
        const engine = new SyncEngine(deps)
        await engine.start()

        const callsAfterStart = setIntervalSpy.mock.calls.length
        ;(network as EventEmitter).emit('status-changed', { online: false })
        ;(network as EventEmitter).emit('status-changed', { online: true })

        await vi.waitFor(() => {
          expect(setIntervalSpy.mock.calls.length).toBeGreaterThan(callsAfterStart)
        })

        await engine.stop()
        vi.restoreAllMocks()
      })
    })

    describe('#given push encounters network error #when error is network_offline', () => {
      it('#then transitions to offline state instead of error', async () => {
        vi.spyOn(await import('./http-client'), 'postToServer').mockRejectedValue(
          new NetworkError('Network request failed')
        )
        const deps = createMockDeps(testDb)
        const engine = new SyncEngine(deps)

        deps.queue.enqueue({
          type: 'task',
          itemId: 'task-1',
          operation: 'create',
          payload: JSON.stringify({ title: 'Test', clock: { 'device-1': 1 } })
        })

        await engine.push()

        expect(engine.currentState).toBe('offline')
        expect(engine.getStatus().error).toBeUndefined()

        vi.restoreAllMocks()
      })
    })

    describe('#given engine offline 25+ hours #when reconnecting', () => {
      it('#then resets cursor for full re-pull', async () => {
        vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
          items: [],
          deleted: [],
          hasMore: false,
          nextCursor: 0
        })

        const deps = createMockDeps(testDb)
        const engine = new SyncEngine(deps)

        // @ts-expect-error accessing private for test
        engine.setStateValue('lastCursor', '12345')

        const TWENTY_FIVE_HOURS_MS = 25 * 60 * 60 * 1000
        // @ts-expect-error accessing private for test
        await engine.reconnectSync(TWENTY_FIVE_HOURS_MS)

        // @ts-expect-error accessing private for test
        const cursor = engine.getStateValue('lastCursor')
        expect(cursor).toBe('0')

        vi.restoreAllMocks()
      })
    })

    describe('#given engine offline 30 minutes #when reconnecting', () => {
      it('#then preserves existing cursor for incremental pull', async () => {
        const getServerMock = vi
          .spyOn(await import('./http-client'), 'getFromServer')
          .mockResolvedValue({
            items: [],
            deleted: [],
            hasMore: false,
            nextCursor: 99999
          })

        const deps = createMockDeps(testDb)
        const engine = new SyncEngine(deps)

        // @ts-expect-error accessing private for test
        engine.setStateValue('lastCursor', '12345')

        const THIRTY_MINUTES_MS = 30 * 60 * 1000
        // @ts-expect-error accessing private for test
        await engine.reconnectSync(THIRTY_MINUTES_MS)

        const changesCall = getServerMock.mock.calls.find((c) =>
          String(c[0]).includes('/sync/changes')
        )
        expect(changesCall).toBeDefined()
        expect(String(changesCall![0])).toContain('cursor=12345')

        vi.restoreAllMocks()
      })
    })

    describe('#given engine is offline #when status event emitted', () => {
      it('#then includes offlineSince in status event', async () => {
        const network = createMockNetwork(false)
        const deps = createMockDeps(testDb, { network })
        const engine = new SyncEngine(deps)
        await engine.start()

        expect(engine.currentState).toBe('offline')
        const status = engine.getStatus()
        expect(status.offlineSince).toBeDefined()
        expect(typeof status.offlineSince).toBe('number')

        const emitCalls = vi.mocked(deps.emitToRenderer).mock.calls
        const statusCall = emitCalls.find((c) => c[0] === 'sync:status-changed')
        expect(statusCall).toBeDefined()
        expect((statusCall![1] as { offlineSince?: number }).offlineSince).toBeDefined()
      })
    })
  })

  describe('Remote wipe detection (T245k)', () => {
    it('#given device revoked on server #when checkDeviceStatus called #then returns revoked', async () => {
      // #given
      const { SyncServerError } = await import('./http-client')
      vi.spyOn(await import('./http-client'), 'getFromServer').mockRejectedValue(
        new SyncServerError('Forbidden', 403, 'AUTH_DEVICE_REVOKED: Device has been revoked')
      )

      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      // #when
      const status = await engine.checkDeviceStatus()

      // #then
      expect(status).toBe('revoked')
      vi.restoreAllMocks()
    })

    it('#given device active on server #when checkDeviceStatus called #then returns active', async () => {
      // #given
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })

      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      // #when
      const status = await engine.checkDeviceStatus()

      // #then
      expect(status).toBe('active')
      vi.restoreAllMocks()
    })

    it('#given device revoked #when start() called #then does not connect WS and emits device_revoked', async () => {
      // #given
      const { SyncServerError } = await import('./http-client')
      vi.spyOn(await import('./http-client'), 'getFromServer').mockRejectedValue(
        new SyncServerError('Forbidden', 403, 'AUTH_DEVICE_REVOKED: Device has been revoked')
      )

      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      const revokedEvents: string[] = []
      engine.on('device_revoked_on_launch', () => revokedEvents.push('revoked'))

      // #when
      await engine.start()

      // #then
      expect(engine.currentState).toBe('error')
      expect(revokedEvents).toHaveLength(1)
      expect(deps.ws.connect).not.toHaveBeenCalled()
      expect(deps.emitToRenderer).toHaveBeenCalledWith(
        'sync:device-removed',
        expect.objectContaining({ unsyncedCount: expect.any(Number) })
      )

      vi.restoreAllMocks()
    })

    it('#given engine running #when performEmergencyWipe called #then clears state and zeros keys', async () => {
      // #given
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })

      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      // #when
      await engine.performEmergencyWipe()

      // #then
      expect(engine.currentState).toBe('idle')
      expect(deps.ws.disconnect).toHaveBeenCalled()

      vi.restoreAllMocks()
    })
  })
})
