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
        items: [], deleted: [], hasMore: false, nextCursor: 0
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
        items: [], deleted: [], hasMore: false, nextCursor: 0
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
        items: [], deleted: [], hasMore: false, nextCursor: 0
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
        items: [], deleted: [], hasMore: false, nextCursor: 0
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
        items: [], deleted: [], hasMore: false, nextCursor: 0
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
        items: [], deleted: [], hasMore: false, nextCursor: 0
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

      const getServerMock = vi.fn().mockImplementation(
        () => blockingPromise.then(() => ({
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
})
