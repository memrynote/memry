import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { SyncEngine, type SyncEngineDeps } from './engine'
import { SyncQueueManager } from './queue'
import { NetworkMonitor } from './network'
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
        contentHash: 'abc',
        sizeBytes: 100
      })

      const { encryptItemForPush: origEncrypt } = await import('./encrypt')
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

      expect(engine.currentState).not.toBe('offline')
      expect(deps.ws.connect).toHaveBeenCalled()

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
        contentHash: 'abc',
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
        contentHash: 'abc',
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
        contentHash: 'abc',
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
        contentHash: 'abc',
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
        contentHash: 'abc',
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
          contentHash: 'abc',
          sizeBytes: 100
        }
      })

      const postMock = vi.fn().mockImplementation(async (_url: string, body: { items: Array<{ id: string }> }) => ({
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
        contentHash: 'abc',
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
        contentHash: 'abc',
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
        contentHash: 'abc',
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
        contentHash: 'hash-abc',
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
      const pushEvents = itemSyncedCalls.filter(
        (call) => call[1]?.operation === 'push'
      )
      const pullEvents = itemSyncedCalls.filter(
        (call) => call[1]?.operation === 'pull'
      )
      expect(pushEvents).toHaveLength(1)
      expect(pullEvents).toHaveLength(1)

      vi.restoreAllMocks()
    })
  })
})
