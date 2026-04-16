import { describe, it, expect, vi } from 'vitest'
import { SyncEngine } from './engine'
import { createMockDeps, setupTestDb } from '@tests/utils/engine-mocks'

describe('SyncEngine', () => {
  const { getDb } = setupTestDb()

  describe('#given engine with queued items #when push called', () => {
    it('#then encrypts and sends items to server', async () => {
      const deps = createMockDeps(getDb())
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

  describe('#given engine with empty queue #when push called -A', () => {
    it('#then returns without making network calls', async () => {
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      const postSpy = vi.spyOn(await import('./http-client'), 'postToServer')

      await engine.push()

      expect(postSpy).not.toHaveBeenCalled()
      vi.restoreAllMocks()
    })
  })

  describe('#given engine #when push succeeds', () => {
    it('#then updates lastSyncAt', async () => {
      const deps = createMockDeps(getDb())
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
      const deps = createMockDeps(getDb())
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

  describe('#given engine with empty queue #when push called -B', () => {
    it('#then does NOT update lastSyncAt', async () => {
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      expect(engine.getStatus().lastSyncAt).toBeUndefined()

      await engine.push()

      expect(engine.getStatus().lastSyncAt).toBeUndefined()
    })
  })

  describe('#given engine with mixed server accept/reject #when push called', () => {
    it('#then calls markSuccess for accepted and markFailed for rejected', async () => {
      const deps = createMockDeps(getDb())
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

      expect(markSuccessSpy).toHaveBeenCalledTimes(1)
      expect(markFailedSpy.mock.calls.length).toBeGreaterThanOrEqual(1)
      expect(markFailedSpy).toHaveBeenCalledWith(expect.any(String), 'Conflict')

      vi.restoreAllMocks()
    })
  })

  describe('#given engine #when push drains queue completely', () => {
    it('#then emits QUEUE_CLEARED event', async () => {
      const deps = createMockDeps(getDb())
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

      await engine.push()

      expect(deps.emitToRenderer).toHaveBeenCalledWith(
        'sync:queue-cleared',
        expect.objectContaining({ itemCount: 1, duration: expect.any(Number) })
      )

      vi.restoreAllMocks()
    })
  })

  describe('#given server time skewed >5min #when push succeeds', () => {
    it('#then emits CLOCK_SKEW_WARNING event', async () => {
      const deps = createMockDeps(getDb())
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

      await engine.push()

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
      const deps = createMockDeps(getDb())
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

      await engine.push()

      const clockSkewCalls = (deps.emitToRenderer as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([channel]: [string]) => channel === 'sync:clock-skew-warning'
      )
      expect(clockSkewCalls).toHaveLength(0)

      vi.restoreAllMocks()
    })
  })

  describe('#given 150+ queued items #when push called', () => {
    it('#then sends multiple batches', async () => {
      const deps = createMockDeps(getDb())
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

      await engine.push()

      expect(postMock).toHaveBeenCalledTimes(2)
      expect(deps.queue.getPendingCount()).toBe(0)

      vi.restoreAllMocks()
    })
  })

  describe('#given clock skew detection', () => {
    it('#then pauses sync when skew exceeds threshold', async () => {
      const deps = createMockDeps(getDb())
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

      await engine.push()

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
      const deps = createMockDeps(getDb())
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

      await engine.push()

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
      const deps = createMockDeps(getDb())
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

      await engine.push()

      const clockSkewCalls = (deps.emitToRenderer as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[0] === 'sync:clock-skew-warning'
      )
      expect(clockSkewCalls).toHaveLength(0)

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

      const deps = createMockDeps(getDb())
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

  describe('#given engine #when requestPush called multiple times rapidly', () => {
    it('#then debounces into single push', async () => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })

      const deps = createMockDeps(getDb())
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
      const deps = createMockDeps(getDb())
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

      const deps = createMockDeps(getDb())
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
      const deps = createMockDeps(getDb())
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

  describe('#given SYNC_REPLAY_DETECTED rejection #when push processes response', () => {
    it('#then treats replay as success and removes from queue', async () => {
      const deps = createMockDeps(getDb())
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

      await engine.push()

      expect(markSuccessSpy).toHaveBeenCalled()
      expect(markFailedSpy).not.toHaveBeenCalled()
      expect(deps.queue.getPendingCount()).toBe(0)

      vi.restoreAllMocks()
    })
  })

  describe('#given duplicate queue items for same itemId #when push called', () => {
    it('#then deduplicates and marks extras as success', async () => {
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      const id1 = deps.queue.enqueue({
        type: 'task',
        itemId: 'task-dup',
        operation: 'update',
        payload: JSON.stringify({ title: 'V1', clock: { 'device-1': 1 } })
      })

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

      await engine.push()

      expect(markSuccessSpy).toHaveBeenCalledTimes(2)
      expect(deps.queue.getPendingCount()).toBe(0)

      vi.restoreAllMocks()
    })
  })

  describe('#given handler with buildPushPayload #when push called for upsert', () => {
    it('#then uses fresh payload instead of frozen queue payload', async () => {
      const deps = createMockDeps(getDb())
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

      await engine.push()

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
      const deps = createMockDeps(getDb())
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

      await engine.push()

      expect(mockHandler.buildPushPayload).not.toHaveBeenCalled()
      expect(capturedContent).toBe(frozenPayload)

      vi.restoreAllMocks()
    })
  })

  describe('#given push fails with 403 AUTH_DEVICE_REVOKED', () => {
    it('#then handles device revocation instead of generic error', async () => {
      const { SyncServerError } = await import('./http-client')
      const deps = createMockDeps(getDb())
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
})
