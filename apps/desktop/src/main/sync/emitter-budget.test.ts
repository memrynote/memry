import { describe, it, expect, vi, afterEach } from 'vitest'
import { NetworkMonitor, type NetworkMonitorDeps } from './network'
import { WebSocketManager } from './websocket'
import { SyncEngine } from './engine'
import { createMockDeps, setupTestDb } from '@tests/utils/engine-mocks'

/**
 * The three sync emitters used to carry `setMaxListeners(50)`, which meant an
 * accumulating-subscriber bug could reach 49 instances per event before Node
 * said anything. These tests pin the real steady-state counts so the ceiling
 * can stay near Node's default of 10 — low enough that a leak warns, high
 * enough that normal operation never does.
 */
const EXPECTED_LISTENER_BUDGET = 10

function createNetworkDeps(): NetworkMonitorDeps {
  return {
    getIsOnline: () => true,
    onResume: () => {},
    onSuspend: () => {},
    offResume: () => {},
    offSuspend: () => {}
  }
}

function createWebSocketManager(): WebSocketManager {
  return new WebSocketManager({
    getAccessToken: async () => 'token',
    getAppVersion: () => '1.0.0',
    isOnline: () => true,
    serverUrl: 'https://sync.invalid'
  })
}

describe('sync emitter listener budgets', () => {
  const { getDb } = setupTestDb()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('#given the three sync emitters #when constructed', () => {
    it('#then each keeps a ceiling low enough to still warn on a leak', () => {
      const monitor = new NetworkMonitor(0, createNetworkDeps())
      const ws = createWebSocketManager()
      const engine = new SyncEngine(createMockDeps(getDb()))

      expect(monitor.getMaxListeners()).toBe(EXPECTED_LISTENER_BUDGET)
      expect(ws.getMaxListeners()).toBe(EXPECTED_LISTENER_BUDGET)
      expect(engine.getMaxListeners()).toBe(EXPECTED_LISTENER_BUDGET)
    })
  })

  describe('#given a NetworkMonitor #when every real subscriber attaches', () => {
    it('#then the count stays well inside the budget', () => {
      const monitor = new NetworkMonitor(0, createNetworkDeps())

      // The three production subscribers: SyncEngine, the sync runtime, and the
      // attachment UploadQueue. See engine.ts, runtime.ts and upload-queue.ts.
      monitor.on('status-changed', () => {})
      monitor.on('status-changed', () => {})
      monitor.on('status-changed', () => {})

      expect(monitor.listenerCount('status-changed')).toBe(3)
      expect(monitor.listenerCount('status-changed')).toBeLessThan(monitor.getMaxListeners())

      monitor.stop()
    })
  })

  describe('#given a WebSocketManager #when constructed', () => {
    it('#then only its own error logger is attached', () => {
      const ws = createWebSocketManager()

      // The engine adds one listener per event name on top of this; nothing
      // stacks multiple listeners on the same event.
      expect(ws.listenerCount('error')).toBe(1)
      expect(ws.eventNames()).toEqual(['error'])
    })
  })

  describe('#given an engine #when it runs a full start/stop cycle', () => {
    it('#then every listener it attached is gone again', async () => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      await engine.start()

      // Exactly one listener per event — a second start/stop cycle must not
      // double these, which is what the lowered ceiling now guards.
      expect(deps.network.listenerCount('status-changed')).toBe(1)
      expect(deps.ws.listenerCount('message')).toBe(1)
      expect(deps.ws.listenerCount('connected')).toBe(1)
      expect(deps.ws.listenerCount('device_revoked')).toBe(1)
      expect(deps.ws.listenerCount('certificate_pin_failed')).toBe(1)

      await engine.stop()

      expect(deps.network.listenerCount('status-changed')).toBe(0)
      expect(deps.ws.listenerCount('message')).toBe(0)
      expect(deps.ws.listenerCount('connected')).toBe(0)
      expect(deps.ws.listenerCount('device_revoked')).toBe(0)
      expect(deps.ws.listenerCount('certificate_pin_failed')).toBe(0)
    })

    it('#then repeated cycles never accumulate listeners', async () => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })
      const deps = createMockDeps(getDb())

      // Well past the old ceiling of 50: under the previous budget an engine
      // that forgot to detach would have hit the warning here and nowhere else.
      for (let i = 0; i < 6; i++) {
        const engine = new SyncEngine(deps)
        await engine.start()
        await engine.stop()
      }

      expect(deps.network.listenerCount('status-changed')).toBe(0)
      expect(deps.ws.listenerCount('message')).toBe(0)
    })
  })
})
