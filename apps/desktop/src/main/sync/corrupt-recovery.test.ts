import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { SyncEngine, type SyncEngineDeps } from './engine'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { NetworkMonitor } from './network'
import type { WebSocketManager } from './websocket'
import type { DecryptedPullItem, DecryptionFailure } from '@memry/sync-client/worker-protocol'
import type { PullItemResponse } from '@memry/contracts/sync-api'
import { ItemApplier } from './apply-item'

function createMockNetwork(online = true): NetworkMonitor {
  const monitor = new EventEmitter() as NetworkMonitor & { _online: boolean }
  monitor._online = online
  Object.defineProperty(monitor, 'online', { get: () => monitor._online })
  monitor.start = vi.fn()
  monitor.stop = vi.fn()
  return monitor
}

function createMockWs(): WebSocketManager {
  const ws = new EventEmitter() as WebSocketManager & { _connected: boolean }
  ws._connected = false
  Object.defineProperty(ws, 'connected', { get: () => ws._connected })
  ws.connect = vi.fn(async () => {
    ws._connected = true
  })
  ws.disconnect = vi.fn(() => {
    ws._connected = false
  })
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

function makePullItem(id: string, type: string): PullItemResponse {
  return {
    id,
    type: type as PullItemResponse['type'],
    operation: 'update' as const,
    signature: 'sig-' + id,
    signerDeviceId: 'device-1',
    blob: {
      encryptedKey: 'ek',
      keyNonce: 'kn',
      encryptedData: 'ed',
      dataNonce: 'dn'
    }
  }
}

function makeDecryptedItem(id: string, type: string, content: string): DecryptedPullItem {
  return {
    id,
    type,
    operation: 'update',
    content,
    clock: { 'device-1': 1 },
    signerDeviceId: 'device-1'
  }
}

function makeCryptoFailure(id: string, type: string): DecryptionFailure {
  return {
    id,
    type,
    signerDeviceId: 'device-1',
    error: 'Decryption failed',
    isCryptoError: true,
    isSignatureError: false
  }
}

describe('Corrupt item recovery', () => {
  let testDb: TestDatabaseResult
  let applySpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    testDb = createTestDataDb()
  })

  afterEach(() => {
    testDb.close()
    vi.restoreAllMocks()
  })

  async function setupMocks(opts: {
    firstDecryptResult: { decrypted: DecryptedPullItem[]; failures: DecryptionFailure[] }
    secondDecryptResult?: { decrypted: DecryptedPullItem[]; failures: DecryptionFailure[] }
    pullItems: PullItemResponse[]
    applyBehavior?: (input: {
      itemId: string
      content: Uint8Array
    }) => 'applied' | 'skipped' | 'conflict' | 'parse_error'
  }) {
    const getServerMock = vi.fn().mockResolvedValue({
      items: opts.pullItems.map((i) => ({
        id: i.id,
        type: i.type,
        version: 1,
        modifiedAt: 1000,
        size: 10
      })),
      deleted: [],
      hasMore: false,
      nextCursor: 1
    })
    vi.spyOn(await import('./http-client'), 'getFromServer').mockImplementation(getServerMock)

    const postServerMock = vi.fn().mockResolvedValue({ items: opts.pullItems })
    vi.spyOn(await import('./http-client'), 'postToServer').mockImplementation(postServerMock)

    let decryptCallCount = 0
    const decryptMock = vi.fn().mockImplementation(() => {
      decryptCallCount++
      if (decryptCallCount === 1) return opts.firstDecryptResult
      return opts.secondDecryptResult ?? { decrypted: [], failures: [] }
    })
    vi.spyOn(await import('./sync-crypto-batch'), 'decryptPullBatch').mockImplementation(
      decryptMock
    )

    const defaultApply = opts.applyBehavior ?? (() => 'applied' as const)
    applySpy = vi.spyOn(ItemApplier.prototype, 'apply').mockImplementation((input) => {
      return defaultApply(input as { itemId: string; content: Uint8Array })
    })

    return { getServerMock, postServerMock, decryptMock, applySpy }
  }

  describe('#given item fails decrypt on first pull #when re-fetch succeeds', () => {
    it('#then re-fetches and applies the recovered item', async () => {
      const items = [makePullItem('task-1', 'task'), makePullItem('task-2', 'task')]

      const { postServerMock } = await setupMocks({
        pullItems: items,
        firstDecryptResult: {
          decrypted: [makeDecryptedItem('task-1', 'task', '{"title":"OK"}')],
          failures: [makeCryptoFailure('task-2', 'task')]
        },
        secondDecryptResult: {
          decrypted: [makeDecryptedItem('task-2', 'task', '{"title":"Recovered"}')],
          failures: []
        }
      })

      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      await engine.pull()

      expect(postServerMock).toHaveBeenCalledTimes(2)
      expect(postServerMock).toHaveBeenLastCalledWith(
        '/sync/pull',
        { itemIds: ['task-2'] },
        'test-token'
      )

      expect(deps.emitToRenderer).toHaveBeenCalledWith(
        'sync:item-recovered',
        expect.objectContaining({ itemId: 'task-2', type: 'task' })
      )
    })
  })

  describe('#given item fails both times #when re-fetch also fails', () => {
    it('#then emits corrupt event and tracks as permanent failure', async () => {
      const items = [makePullItem('task-1', 'task'), makePullItem('task-2', 'task')]

      await setupMocks({
        pullItems: items,
        firstDecryptResult: {
          decrypted: [makeDecryptedItem('task-1', 'task', '{"title":"OK"}')],
          failures: [makeCryptoFailure('task-2', 'task')]
        },
        secondDecryptResult: {
          decrypted: [],
          failures: [makeCryptoFailure('task-2', 'task')]
        }
      })

      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      await engine.pull()

      expect(deps.emitToRenderer).toHaveBeenCalledWith(
        'sync:item-corrupt',
        expect.objectContaining({
          itemId: 'task-2',
          type: 'task',
          error: expect.stringContaining('corrupt')
        })
      )
    })
  })

  describe('#given all items fail crypto on first attempt #when circuit breaker check runs', () => {
    it('#then does NOT attempt re-fetch (preserves circuit breaker)', async () => {
      const items = [makePullItem('task-1', 'task'), makePullItem('task-2', 'task')]

      const { postServerMock } = await setupMocks({
        pullItems: items,
        firstDecryptResult: {
          decrypted: [],
          failures: [makeCryptoFailure('task-1', 'task'), makeCryptoFailure('task-2', 'task')]
        }
      })

      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      await engine.pull()

      expect(postServerMock).toHaveBeenCalledTimes(1)
      expect(engine.currentState).toBe('error')
    })
  })

  describe('#given previously-failed item within cooldown #when pull encounters same item', () => {
    it('#then skips re-fetch for that item', async () => {
      const items = [makePullItem('task-1', 'task'), makePullItem('task-2', 'task')]

      const firstMocks = await setupMocks({
        pullItems: items,
        firstDecryptResult: {
          decrypted: [makeDecryptedItem('task-1', 'task', '{"title":"OK"}')],
          failures: [makeCryptoFailure('task-2', 'task')]
        },
        secondDecryptResult: {
          decrypted: [],
          failures: [makeCryptoFailure('task-2', 'task')]
        }
      })

      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      await engine.pull()
      expect(firstMocks.postServerMock).toHaveBeenCalledTimes(2)

      vi.restoreAllMocks()

      const secondMocks = await setupMocks({
        pullItems: items,
        firstDecryptResult: {
          decrypted: [makeDecryptedItem('task-1', 'task', '{"title":"OK"}')],
          failures: [makeCryptoFailure('task-2', 'task')]
        }
      })

      await engine.pull()

      expect(secondMocks.postServerMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('#given item decrypts OK but JSON is malformed #when re-fetch returns valid JSON', () => {
    it('#then recovers via parse_error path', async () => {
      const items = [makePullItem('task-1', 'task'), makePullItem('task-2', 'task')]

      await setupMocks({
        pullItems: items,
        firstDecryptResult: {
          decrypted: [
            makeDecryptedItem('task-1', 'task', '{"title":"OK"}'),
            makeDecryptedItem('task-2', 'task', '{INVALID JSON}')
          ],
          failures: []
        },
        secondDecryptResult: {
          decrypted: [makeDecryptedItem('task-2', 'task', '{"title":"Fixed"}')],
          failures: []
        },
        applyBehavior: (input) => {
          const decoded = new TextDecoder().decode(input.content)
          try {
            JSON.parse(decoded)
            return 'applied'
          } catch {
            return 'parse_error'
          }
        }
      })

      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      await engine.pull()

      expect(deps.emitToRenderer).toHaveBeenCalledWith(
        'sync:item-recovered',
        expect.objectContaining({ itemId: 'task-2', type: 'task' })
      )
    })
  })

  describe('#given Zod schema validation fails #when applying item', () => {
    it('#then does NOT attempt re-fetch (schema drift returns skipped)', async () => {
      const items = [makePullItem('task-1', 'task'), makePullItem('task-2', 'task')]

      const { postServerMock } = await setupMocks({
        pullItems: items,
        firstDecryptResult: {
          decrypted: [
            makeDecryptedItem('task-1', 'task', '{"title":"OK"}'),
            makeDecryptedItem('task-2', 'task', '{"title":"OK"}')
          ],
          failures: []
        },
        applyBehavior: () => 'skipped'
      })

      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      await engine.pull()

      expect(postServerMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('#given mixed failures #when some are crypto and some are parse errors', () => {
    it('#then re-fetches only crypto + parse error items', async () => {
      const items = [
        makePullItem('task-1', 'task'),
        makePullItem('task-2', 'task'),
        makePullItem('task-3', 'task')
      ]

      const { postServerMock } = await setupMocks({
        pullItems: items,
        firstDecryptResult: {
          decrypted: [
            makeDecryptedItem('task-1', 'task', '{"title":"OK"}'),
            makeDecryptedItem('task-3', 'task', '{BAD JSON}')
          ],
          failures: [makeCryptoFailure('task-2', 'task')]
        },
        secondDecryptResult: {
          decrypted: [
            makeDecryptedItem('task-2', 'task', '{"title":"Recovered2"}'),
            makeDecryptedItem('task-3', 'task', '{"title":"Recovered3"}')
          ],
          failures: []
        },
        applyBehavior: (input) => {
          const decoded = new TextDecoder().decode(input.content)
          try {
            JSON.parse(decoded)
            return 'applied'
          } catch {
            return 'parse_error'
          }
        }
      })

      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      await engine.pull()

      expect(postServerMock).toHaveBeenCalledTimes(2)
      const refetchCall = postServerMock.mock.calls[1]
      expect(refetchCall[0]).toBe('/sync/pull')
      const refetchIds = (refetchCall[1] as { itemIds: string[] }).itemIds
      expect(refetchIds).toContain('task-2')
      expect(refetchIds).toContain('task-3')
      expect(refetchIds).not.toContain('task-1')
    })
  })

  // ==========================================================================
  // Vault-key mismatch gate — when EVERY item in a page fails decrypt/verify,
  // the vault key is the suspect, not the items. A confirmed account-key
  // mismatch must stop the cycle without branding items corrupt, without
  // quarantining them, and without security toasts.
  // ==========================================================================

  function makeSignatureFailure(id: string, type: string): DecryptionFailure {
    return {
      id,
      type,
      signerDeviceId: 'device-1',
      error: `Signature verification failed for item ${id} from device device-1`,
      isCryptoError: true,
      isSignatureError: true
    }
  }

  describe('#given every item in the page fails decrypt', () => {
    it('#then a confirmed key mismatch stops the cycle with no quarantine, no security toast, no re-fetch', async () => {
      const items = [makePullItem('n-1', 'note'), makePullItem('n-2', 'note')]
      const { postServerMock } = await setupMocks({
        pullItems: items,
        firstDecryptResult: {
          decrypted: [],
          failures: [makeCryptoFailure('n-1', 'note'), makeSignatureFailure('n-2', 'note')]
        }
      })

      const onVaultKeyMismatch = vi.fn()
      const deps = createMockDeps(testDb, {
        checkAccountKey: vi.fn().mockResolvedValue('mismatch'),
        onVaultKeyMismatch
      })
      const engine = new SyncEngine(deps)

      await engine.pull()

      expect(onVaultKeyMismatch).toHaveBeenCalledTimes(1)
      // No re-fetch attempt: only the page pull hit /sync/pull.
      expect(postServerMock).toHaveBeenCalledTimes(1)
      // No SECURITY_WARNING toast for the signature failure.
      const emitted = vi.mocked(deps.emitToRenderer).mock.calls.map(([channel]) => channel)
      expect(emitted).not.toContain('sync:security-warning')
      expect(emitted).not.toContain('sync:item-corrupt')
      // Nothing persisted to quarantine.
      expect(engine.getQuarantinedItems()).toEqual([])
      // The user-facing state is the single key-mismatch error.
      expect(engine.getStatus().error).toContain('vault key mismatch')
    })

    it('#then a key-material transition stops the cycle quietly — no side effects, no escalation', async () => {
      const items = [makePullItem('n-1', 'note')]
      const { postServerMock } = await setupMocks({
        pullItems: items,
        firstDecryptResult: {
          decrypted: [],
          failures: [makeCryptoFailure('n-1', 'note')]
        }
      })

      const onVaultKeyMismatch = vi.fn()
      const deps = createMockDeps(testDb, {
        checkAccountKey: vi.fn().mockResolvedValue('transition'),
        onVaultKeyMismatch
      })
      const engine = new SyncEngine(deps)

      await engine.pull()

      expect(onVaultKeyMismatch).not.toHaveBeenCalled()
      expect(postServerMock).toHaveBeenCalledTimes(1)
      const emitted = vi.mocked(deps.emitToRenderer).mock.calls.map(([channel]) => channel)
      expect(emitted).not.toContain('sync:security-warning')
      expect(emitted).not.toContain('sync:item-corrupt')
      expect(engine.getQuarantinedItems()).toEqual([])
    })

    it('#then a healthy key (match) keeps the existing corruption handling', async () => {
      const items = [makePullItem('n-1', 'note')]
      await setupMocks({
        pullItems: items,
        firstDecryptResult: {
          decrypted: [],
          failures: [makeSignatureFailure('n-1', 'note')]
        }
      })

      const onVaultKeyMismatch = vi.fn()
      const deps = createMockDeps(testDb, {
        checkAccountKey: vi.fn().mockResolvedValue('match'),
        onVaultKeyMismatch
      })
      const engine = new SyncEngine(deps)

      await engine.pull()

      expect(onVaultKeyMismatch).not.toHaveBeenCalled()
      // Signature failure goes through the normal quarantine + security toast.
      const emitted = vi.mocked(deps.emitToRenderer).mock.calls.map(([channel]) => channel)
      expect(emitted).toContain('sync:security-warning')
      expect(engine.getQuarantinedItems().map((q) => q.itemId)).toContain('n-1')
    })

    it('#then no checker configured keeps the existing behavior (backward compatible)', async () => {
      const items = [makePullItem('n-1', 'note')]
      await setupMocks({
        pullItems: items,
        firstDecryptResult: {
          decrypted: [],
          failures: [makeSignatureFailure('n-1', 'note')]
        }
      })

      const deps = createMockDeps(testDb)
      const engine = new SyncEngine(deps)

      await engine.pull()

      const emitted = vi.mocked(deps.emitToRenderer).mock.calls.map(([channel]) => channel)
      expect(emitted).toContain('sync:security-warning')
      expect(engine.getQuarantinedItems().map((q) => q.itemId)).toContain('n-1')
    })

    it('#then a partial failure never consults the account key (items decrypt → key is fine)', async () => {
      const items = [makePullItem('n-1', 'note'), makePullItem('n-2', 'note')]
      const checkAccountKey = vi.fn().mockResolvedValue('mismatch')
      await setupMocks({
        pullItems: items,
        firstDecryptResult: {
          decrypted: [makeDecryptedItem('n-1', 'note', '{"title":"ok"}')],
          failures: [makeCryptoFailure('n-2', 'note')]
        }
      })

      const deps = createMockDeps(testDb, { checkAccountKey, onVaultKeyMismatch: vi.fn() })
      const engine = new SyncEngine(deps)

      await engine.pull()

      expect(checkAccountKey).not.toHaveBeenCalled()
    })
  })
})
