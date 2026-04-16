import { vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { type SyncEngineDeps } from '@main/sync/engine'
import { SyncQueueManager } from '@main/sync/queue'
import { NetworkMonitor } from '@main/sync/network'
import type { WebSocketManager } from '@main/sync/websocket'

export type { TestDatabaseResult }

export function createMockNetwork(online = true): NetworkMonitor {
  const monitor = new EventEmitter() as NetworkMonitor & { _online: boolean }
  monitor._online = online
  Object.defineProperty(monitor, 'online', { get: () => monitor._online })
  monitor.start = vi.fn()
  monitor.stop = vi.fn()
  return monitor
}

export function createMockWs(): WebSocketManager & { simulateConnected: () => void } {
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

export function createMockDeps(
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

export function setupTestDb(): { getDb: () => TestDatabaseResult } {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDataDb()
  })

  afterEach(() => {
    testDb.close()
  })

  return { getDb: () => testDb }
}
