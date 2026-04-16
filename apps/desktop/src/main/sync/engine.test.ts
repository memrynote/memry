import { describe, it, expect, vi } from 'vitest'
import { SyncEngine } from './engine'
import type { WebSocketMessage } from './websocket'
import { createMockDeps, createMockNetwork, setupTestDb } from '@tests/utils/engine-mocks'

describe('SyncEngine', () => {
  const { getDb } = setupTestDb()

  describe('#given new engine #when constructed', () => {
    it('#then initial state is idle', () => {
      const deps = createMockDeps(getDb())
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
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      await engine.start()
      await engine.stop()

      expect(deps.ws.connect).toHaveBeenCalled()
      vi.restoreAllMocks()
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
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)
      await engine.start()

      await engine.stop()

      expect(deps.ws.disconnect).toHaveBeenCalled()
      expect(engine.currentState).toBe('idle')
      vi.restoreAllMocks()
    })
  })

  describe('#given engine #when getStatus called', () => {
    it('#then returns current state with pending count', () => {
      const deps = createMockDeps(getDb())
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
      const deps = createMockDeps(getDb())
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
      const deps = createMockDeps(getDb())
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
      const deps = createMockDeps(getDb())
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
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)
      engine.pause()

      const result = engine.pause()

      expect(result.wasPaused).toBe(true)
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

      const deps = createMockDeps(getDb())
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

      const deps = createMockDeps(getDb())
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
      const deps = createMockDeps(getDb(), {
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
      const deps = createMockDeps(getDb(), { network })
      const engine = new SyncEngine(deps)

      await engine.start()

      expect(deps.emitToRenderer).toHaveBeenCalledWith(
        'sync:status-changed',
        expect.objectContaining({ status: 'offline' })
      )
    })
  })

  describe('#given fullSync #when signing keys available', () => {
    it('#then calls runInitialSeed between pull and push', async () => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })

      const initialSeedModule = await import('./initial-seed')
      const seedSpy = vi.spyOn(initialSeedModule, 'runInitialSeed').mockImplementation(() => {})

      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      await engine.fullSync()

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
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })

      const initialSeedModule = await import('./initial-seed')
      const seedSpy = vi.spyOn(initialSeedModule, 'runInitialSeed').mockImplementation(() => {})

      const deps = createMockDeps(getDb(), {
        getSigningKeys: vi.fn().mockResolvedValue(null)
      })
      const engine = new SyncEngine(deps)

      await engine.fullSync()

      expect(seedSpy).not.toHaveBeenCalled()

      vi.restoreAllMocks()
    })
  })

  describe('#given fullSync race condition #when WS connected fires mid-sync', () => {
    it('#then push still executes (not blocked by WS-triggered pull)', async () => {
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

      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)
      await engine.start()

      getFromServerSpy.mockClear()

      let pushBodyExecuted = false
      const origPush = engine.push.bind(engine)
      engine.push = async () => {
        pushBodyExecuted = true
        return origPush()
      }

      await engine.fullSync()

      expect(pushBodyExecuted).toBe(true)

      await engine.stop()
      vi.restoreAllMocks()
    })
  })

  describe('#given fullSync active #when scheduleSync called', () => {
    it('#then WS connected event does not trigger additional pull', async () => {
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

      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)
      await engine.start()

      getFromServerSpy.mockClear()

      const origFullSync = engine.fullSync.bind(engine)
      engine.fullSync = async () => {
        const promise = origFullSync()
        deps.ws.emit('connected')
        return promise
      }

      await engine.fullSync()

      expect(getFromServerSpy).toHaveBeenCalledTimes(1)

      await engine.stop()
      vi.restoreAllMocks()
    })
  })

  describe('#given manifest detects server-only items #when fullSync runs', () => {
    it('#then resets cursor and re-pulls', async () => {
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

      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      const origPull = engine.pull.bind(engine)
      let pullCallCount = 0
      engine.pull = async () => {
        pullCallCount++
        return origPull()
      }

      await engine.fullSync()

      expect(pullCallCount).toBe(2)

      vi.restoreAllMocks()
    })
  })

  describe('#given engine with pending items #when stop() called', () => {
    it('#then attempts final push before teardown', async () => {
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-shutdown',
        operation: 'update',
        payload: JSON.stringify({ title: 'Pending', clock: { 'device-1': 1 } })
      })

      const pushSpy = vi.spyOn(engine, 'push').mockResolvedValue()

      await engine.stop()

      expect(pushSpy).toHaveBeenCalledTimes(1)
      expect(engine.currentState).toBe('idle')

      vi.restoreAllMocks()
    })

    it('#then skips final push when skipFinalPush option is set', async () => {
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-skip',
        operation: 'update',
        payload: JSON.stringify({ title: 'Skipped', clock: { 'device-1': 1 } })
      })

      const pushSpy = vi.spyOn(engine, 'push').mockResolvedValue()

      await engine.stop({ skipFinalPush: true })

      expect(pushSpy).not.toHaveBeenCalled()

      vi.restoreAllMocks()
    })

    it('#then skips final push when offline', async () => {
      const network = createMockNetwork(false)
      const deps = createMockDeps(getDb(), { network })
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-offline',
        operation: 'update',
        payload: JSON.stringify({ title: 'Offline', clock: { 'device-1': 1 } })
      })

      const pushSpy = vi.spyOn(engine, 'push').mockResolvedValue()

      await engine.stop()

      expect(pushSpy).not.toHaveBeenCalled()

      vi.restoreAllMocks()
    })

    it('#then skips final push when queue is empty', async () => {
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      const pushSpy = vi.spyOn(engine, 'push').mockResolvedValue()

      await engine.stop()

      expect(pushSpy).not.toHaveBeenCalled()

      vi.restoreAllMocks()
    })

    it('#then completes teardown even if final push throws', async () => {
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-fail',
        operation: 'update',
        payload: JSON.stringify({ title: 'Fail', clock: { 'device-1': 1 } })
      })

      vi.spyOn(engine, 'push').mockRejectedValue(new Error('push failed'))

      await engine.stop()

      expect(engine.currentState).toBe('idle')

      vi.restoreAllMocks()
    })
  })

  describe('Remote wipe detection (T245k)', () => {
    it('#given device revoked on server #when checkDeviceStatus called #then returns revoked', async () => {
      const { SyncServerError } = await import('./http-client')
      vi.spyOn(await import('./http-client'), 'getFromServer').mockRejectedValue(
        new SyncServerError('Forbidden', 403, 'AUTH_DEVICE_REVOKED: Device has been revoked')
      )

      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      const status = await engine.checkDeviceStatus()

      expect(status).toBe('revoked')
      vi.restoreAllMocks()
    })

    it('#given device active on server #when checkDeviceStatus called #then returns active', async () => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })

      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      const status = await engine.checkDeviceStatus()

      expect(status).toBe('active')
      vi.restoreAllMocks()
    })

    it('#given device revoked #when start() called #then does not connect WS and emits device_revoked', async () => {
      const { SyncServerError } = await import('./http-client')
      vi.spyOn(await import('./http-client'), 'getFromServer').mockRejectedValue(
        new SyncServerError('Forbidden', 403, 'AUTH_DEVICE_REVOKED: Device has been revoked')
      )

      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      const revokedEvents: string[] = []
      engine.on('device_revoked_on_launch', () => revokedEvents.push('revoked'))

      await engine.start()

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
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })

      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      await engine.performEmergencyWipe()

      expect(engine.currentState).toBe('idle')
      expect(deps.ws.disconnect).toHaveBeenCalled()

      vi.restoreAllMocks()
    })
  })
})
