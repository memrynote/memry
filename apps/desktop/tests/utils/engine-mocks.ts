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

/**
 * Everything the sync engine can read off `deps.ws`, derived from the real
 * class rather than restated. `implements` on this is what turns a member added
 * to WebSocketManager into a compile error here, instead of the mock silently
 * answering `undefined` behind an `as WebSocketManager` cast.
 */
type WebSocketManagerSurface = Omit<WebSocketManager, keyof EventEmitter>

export type MockWebSocketManager = WebSocketManager & { simulateConnected: () => void }

class MockWs extends EventEmitter implements WebSocketManagerSurface {
  private _connected = false
  private _connectionGeneration = 0

  get connected(): boolean {
    return this._connected
  }

  /** Advances once per socket open, mirroring the real manager's getter. */
  get connectionGeneration(): number {
    return this._connectionGeneration
  }

  // Resolving does not mean the socket is up: the real connect() returns once
  // the WebSocket has been constructed, and 'open' lands later. Tests that need
  // a live socket call simulateConnected().
  connect = vi.fn(async (): Promise<void> => {})

  refreshAuth = vi.fn(async (): Promise<void> => {})

  disconnect = vi.fn((): void => {
    this._connected = false
  })

  /** One socket open: flips `connected`, advances the generation, announces it. */
  simulateConnected = (): void => {
    // The real manager opens at most one socket at a time, so a second open
    // without an intervening disconnect is not a new generation.
    if (!this._connected) {
      this._connected = true
      this._connectionGeneration++
    }
    this.emit('connected')
  }
}

export function createMockWs(): MockWebSocketManager {
  // WebSocketManager's private fields make it nominal, so a structural stand-in
  // can never be assignable to it; the surface `implements` above is the check
  // that matters.
  return new MockWs() as unknown as MockWebSocketManager
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
