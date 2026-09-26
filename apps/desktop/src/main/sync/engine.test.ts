import { describe, it, expect, vi } from 'vitest'
import { SyncEngine, SYNC_LOCK_STALE_MS, PERIODIC_PULL_MAX_QUIET_MS } from './engine'
import type { SyncSocketEvent } from '@memry/contracts/sync-socket'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import { SYNC_STATE_KEYS } from './engine/sync-context'
import {
  createMockDeps,
  createMockNetwork,
  createMockWs,
  setupTestDb
} from '@tests/utils/engine-mocks'

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

  describe('#given a vault this device never pulled #when start called', () => {
    it('#then the bootstrap session opens before any change-feed read', async () => {
      // The server spends bootstrap eligibility on the first change-feed page
      // it serves this device, so a launch probe on /sync/changes made every
      // fresh device lose its elevated session (#1837).
      const http = await import('./http-client')
      const requests: string[] = []
      vi.spyOn(http, 'getFromServer').mockImplementation(async (path: string) => {
        requests.push(`GET ${path.split('?')[0]}`)
        return { items: [], deleted: [], hasMore: false, nextCursor: 0 }
      })
      vi.spyOn(http, 'postToServer').mockImplementation(async (path: string) => {
        requests.push(`POST ${path}`)
        return {}
      })
      const engine = new SyncEngine(createMockDeps(getDb()))

      await engine.start()
      await engine.stop()

      expect(requests.slice(0, requests.indexOf('POST /sync/bootstrap') + 1)).toEqual([
        'GET /sync/status',
        'POST /sync/bootstrap'
      ])
      vi.restoreAllMocks()
    })
  })

  describe('#given initial full sync fails #when start called', () => {
    it('#then start resolves and the periodic pull is armed', async () => {
      vi.useFakeTimers()
      const getSpy = vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)
      vi.spyOn(engine, 'fullSync').mockRejectedValueOnce(new Error('transient first-sync failure'))

      // #when — must not throw: a throwing start() tears down the sync runtime
      await engine.start()

      // #then — the 60s tick still pulls, so sync self-heals this session
      const callsAfterStart = getSpy.mock.calls.length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(getSpy.mock.calls.length).toBeGreaterThan(callsAfterStart)

      await engine.stop()
      vi.useRealTimers()
      vi.restoreAllMocks()
    })
  })

  describe('#given a socket that has not dropped #when the 60s pull tick fires', () => {
    // Opened before start() so the engine arms the tick against a socket that
    // is already up — the generation it stamps is the one the ticks then read.
    const startArmedEngineOnLiveSocket = async (
      getSpy: { mock: { calls: unknown[] } },
      ws: ReturnType<typeof createMockWs>
    ): Promise<{ engine: SyncEngine; callsAfterStart: number }> => {
      ws.simulateConnected()
      const engine = new SyncEngine(createMockDeps(getDb(), { ws }))
      // fullSync is exercised elsewhere; here it only has to leave the tick armed.
      vi.spyOn(engine, 'fullSync').mockResolvedValue()
      await engine.start()
      return { engine, callsAfterStart: getSpy.mock.calls.length }
    }

    const mockPullTransport = async (): Promise<ReturnType<typeof vi.spyOn>> =>
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })

    it('#then it issues no request, and pulls again once the socket generation moves', async () => {
      vi.useFakeTimers()
      const getSpy = await mockPullTransport()
      const ws = createMockWs()
      const { engine, callsAfterStart } = await startArmedEngineOnLiveSocket(getSpy, ws)

      // #when — two ticks on the same, still-connected socket
      await vi.advanceTimersByTimeAsync(60_000)
      await vi.advanceTimersByTimeAsync(60_000)

      // #then — nothing could have been missed, so nothing is fetched
      expect(getSpy.mock.calls.length).toBe(callsAfterStart)

      // #when — the socket dropped and came back between ticks
      ws.disconnect()
      ws.simulateConnected()
      await vi.advanceTimersByTimeAsync(60_000)

      // #then — broadcasts may have been missed, so the tick pulls again
      expect(getSpy.mock.calls.length).toBeGreaterThan(callsAfterStart)

      await engine.stop()
      vi.useRealTimers()
      vi.restoreAllMocks()
    })

    it('#then the quiet floor still forces a self-heal pull', async () => {
      // A server that silently stops broadcasting is indistinguishable from a
      // quiet vault, so the tick must not go quiet forever.
      vi.useFakeTimers()
      const getSpy = await mockPullTransport()
      const { engine, callsAfterStart } = await startArmedEngineOnLiveSocket(getSpy, createMockWs())

      await vi.advanceTimersByTimeAsync(PERIODIC_PULL_MAX_QUIET_MS - 60_000)
      expect(getSpy.mock.calls.length).toBe(callsAfterStart)

      await vi.advanceTimersByTimeAsync(60_000)
      expect(getSpy.mock.calls.length).toBeGreaterThan(callsAfterStart)

      await engine.stop()
      vi.useRealTimers()
      vi.restoreAllMocks()
    })

    it('#then a disconnected socket keeps the every-tick pull', async () => {
      vi.useFakeTimers()
      const getSpy = await mockPullTransport()
      const ws = createMockWs()
      const { engine } = await startArmedEngineOnLiveSocket(getSpy, ws)
      ws.disconnect()
      const callsAfterStart = getSpy.mock.calls.length

      await vi.advanceTimersByTimeAsync(60_000)

      expect(getSpy.mock.calls.length).toBeGreaterThan(callsAfterStart)

      await engine.stop()
      vi.useRealTimers()
      vi.restoreAllMocks()
    })
  })

  describe('#given the sync lock is stuck past the stale threshold #when the watchdog runs', () => {
    it('#then force-releases the lock and aborts the in-flight sync', () => {
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)
      const abortController = new AbortController()
      engine['ctx'].syncing = true
      engine['ctx'].fullSyncActive = true
      engine['ctx'].abortController = abortController
      engine['syncLockAcquiredAt'] = Date.now() - SYNC_LOCK_STALE_MS - 1

      engine['recoverStaleSyncLock']()

      expect(engine['ctx'].syncing).toBe(false)
      expect(engine['ctx'].fullSyncActive).toBe(false)
      expect(abortController.signal.aborted).toBe(true)
    })

    it('#then leaves a freshly acquired lock alone', () => {
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)
      engine['ctx'].syncing = true
      engine['syncLockAcquiredAt'] = Date.now()

      engine['recoverStaleSyncLock']()

      expect(engine['ctx'].syncing).toBe(true)
      // The engine is a static singleton: a leaked syncing=true makes every
      // later `new SyncEngine` in this file throw "instance already active".
      engine['ctx'].syncing = false
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

      deps.ws.emit('message', { kind: 'changes_available' } satisfies SyncSocketEvent)

      await pullDone

      expect(getServerMock).toHaveBeenCalled()
      await engine.stop()
      vi.restoreAllMocks()
    })
  })

  describe('#given changes_available wakes #when they arrive in bursts or behind the cursor', () => {
    const PULL_DURATION_MS = 100

    const wake = (cursor?: number): SyncSocketEvent => ({
      kind: 'changes_available',
      ...(cursor === undefined ? {} : { cursor })
    })

    // Every pull takes PULL_DURATION_MS of fake time, so a wake can land while
    // one is running. The pull itself is stubbed: these tests count pulls, and
    // the stub never moves LAST_CURSOR, so only the test decides the cursor.
    const startEngineWithTimedPull = async (): Promise<{
      engine: SyncEngine
      ws: ReturnType<typeof createMockWs>
      pull: ReturnType<typeof vi.spyOn>
    }> => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })
      const ws = createMockWs()
      const engine = new SyncEngine(createMockDeps(getDb(), { ws }))
      vi.spyOn(engine, 'fullSync').mockResolvedValue()
      await engine.start()
      const pull = vi
        .spyOn(engine, 'pull')
        .mockImplementation(
          () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), PULL_DURATION_MS))
        )
      return { engine, ws, pull }
    }

    const stopEngine = async (engine: SyncEngine): Promise<void> => {
      await engine.stop()
      vi.useRealTimers()
      vi.restoreAllMocks()
    }

    // #2290: ten wakes in 50 ms used to queue ten serial pulls.
    it('#then ten wakes within 50 ms cost at most two pulls', async () => {
      vi.useFakeTimers()
      const { engine, ws, pull } = await startEngineWithTimedPull()

      for (let cursor = 1; cursor <= 10; cursor++) {
        ws.emit('message', wake(cursor))
        await vi.advanceTimersByTimeAsync(5)
      }
      await vi.advanceTimersByTimeAsync(PULL_DURATION_MS * 12)

      expect(pull.mock.calls.length).toBeGreaterThanOrEqual(1)
      expect(pull.mock.calls.length).toBeLessThanOrEqual(2)
      await stopEngine(engine)
    })

    // #2290: a wake at or below LAST_CURSOR announces rows this device has
    // already applied (cursors are commit-ordered, #2282).
    it('#then a wake whose cursor is at or below LAST_CURSOR pulls nothing', async () => {
      vi.useFakeTimers()
      const { engine, ws, pull } = await startEngineWithTimedPull()
      engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '42')

      ws.emit('message', wake(42))
      ws.emit('message', wake(7))
      await vi.advanceTimersByTimeAsync(PULL_DURATION_MS * 3)

      expect(pull).not.toHaveBeenCalled()
      // The filter only skips: LAST_CURSOR is still the pull's to move.
      expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('42')

      ws.emit('message', wake(43))
      ws.emit('message', wake())
      await vi.advanceTimersByTimeAsync(PULL_DURATION_MS * 3)

      expect(pull.mock.calls.length).toBeGreaterThanOrEqual(1)
      await stopEngine(engine)
    })

    // #2290: wakes during a running pull may announce rows that pull's page
    // already missed, so exactly one pull must follow it — never zero, never one
    // per wake.
    it('#then wakes during a running pull queue exactly one follow-up pull', async () => {
      vi.useFakeTimers()
      const { engine, ws, pull } = await startEngineWithTimedPull()

      ws.emit('message', wake(1))
      await vi.advanceTimersByTimeAsync(PULL_DURATION_MS / 2)
      expect(pull).toHaveBeenCalledTimes(1)

      ws.emit('message', wake(2))
      ws.emit('message', wake(3))
      ws.emit('message', wake(4))
      await vi.advanceTimersByTimeAsync(PULL_DURATION_MS / 2 - 1)
      expect(pull).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(PULL_DURATION_MS * 5)
      expect(pull).toHaveBeenCalledTimes(2)
      await stopEngine(engine)
    })

    // #2290: a follow-up queued behind a sync that never settles must not keep
    // swallowing wakes once the stale-lock watchdog abandons that sync.
    it('#then a wake after the stale-lock watchdog fires schedules a pull again', async () => {
      vi.useFakeTimers()
      const { engine, ws, pull } = await startEngineWithTimedPull()
      pull.mockImplementationOnce(() => new Promise<boolean>(() => {}))

      ws.emit('message', wake(1))
      ws.emit('message', wake(2))
      await vi.advanceTimersByTimeAsync(PULL_DURATION_MS)
      expect(pull).toHaveBeenCalledTimes(1)

      engine['ctx'].syncing = true
      engine['syncLockAcquiredAt'] = Date.now() - SYNC_LOCK_STALE_MS - 1
      engine['recoverStaleSyncLock']()

      ws.emit('message', wake(3))
      await vi.advanceTimersByTimeAsync(PULL_DURATION_MS * 3)
      expect(pull).toHaveBeenCalledTimes(2)
      await stopEngine(engine)
    })
  })

  describe('#given connected engine #when WS receives calendar_changes_available', () => {
    it('#then routes the payload sourceId to deps.calendarSyncOneSource', async () => {
      // #given
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })
      const calendarSyncOneSource = vi.fn()
      const deps = createMockDeps(getDb(), { calendarSyncOneSource })
      const engine = new SyncEngine(deps)
      await engine.start()

      // #when
      deps.ws.emit('message', {
        kind: 'calendar_changes_available',
        sourceId: 'google:primary@group.calendar.google.com'
      } satisfies SyncSocketEvent)

      // #then
      expect(calendarSyncOneSource).toHaveBeenCalledWith('google:primary@group.calendar.google.com')
      await engine.stop()
      vi.restoreAllMocks()
    })
  })

  // #2291: linking frames arrive narrowed by parseSyncSocketFrame; the renderer
  // still gets the LinkingRequestEvent / LinkingApprovedEvent shapes.
  describe('#given connected engine #when WS receives linking frames', () => {
    it('#then forwards them to the renderer as linking events', async () => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)
      await engine.start()

      deps.ws.emit('message', {
        kind: 'linking_request',
        sessionId: 's1',
        newDeviceName: 'Laptop',
        newDevicePlatform: 'macos'
      } satisfies SyncSocketEvent)
      deps.ws.emit('message', {
        kind: 'linking_approved',
        sessionId: 's1'
      } satisfies SyncSocketEvent)

      expect(deps.emitToRenderer).toHaveBeenCalledWith(EVENT_CHANNELS.LINKING_REQUEST, {
        sessionId: 's1',
        newDeviceName: 'Laptop',
        newDevicePlatform: 'macos'
      })
      expect(deps.emitToRenderer).toHaveBeenCalledWith(EVENT_CHANNELS.LINKING_APPROVED, {
        sessionId: 's1'
      })
      await engine.stop()
      vi.restoreAllMocks()
    })
  })

  // #2291: auth_ok and error frames arrive with their fields flattened by
  // parseSyncSocketFrame; only AUTH_DEVICE_REVOKED revokes the device.
  describe('#given connected engine #when WS receives auth_ok and error frames', () => {
    it('#then only an AUTH_DEVICE_REVOKED error revokes the device', async () => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)
      await engine.start()
      const handleDeviceRevoked = vi
        .spyOn(engine as unknown as { handleDeviceRevoked: () => void }, 'handleDeviceRevoked')
        .mockImplementation(() => {})

      deps.ws.emit('message', { kind: 'auth_ok', exp: 123 } satisfies SyncSocketEvent)
      deps.ws.emit('message', {
        kind: 'error',
        code: 'RATE_LIMITED',
        message: 'slow down'
      } satisfies SyncSocketEvent)
      expect(handleDeviceRevoked).not.toHaveBeenCalled()

      deps.ws.emit('message', {
        kind: 'error',
        code: 'AUTH_DEVICE_REVOKED'
      } satisfies SyncSocketEvent)
      expect(handleDeviceRevoked).toHaveBeenCalledTimes(1)

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

  // #2382
  describe('#given an install that skipped a cursor range before the fix #when the first fullSync runs', () => {
    it('#then the skipped update arrives and the repair is recorded', async () => {
      const skippedUpdate = new TextEncoder().encode(
        JSON.stringify({ id: 'task-7', title: 'Updated on B', clock: { 'device-b': 2 } })
      )
      vi.spyOn(await import('./http-client'), 'getFromServer').mockImplementation(
        async (path: string) => {
          if (!path.startsWith('/sync/changes')) return { items: [], serverTime: 0 }
          const cursor = Number(new URL(path, 'http://x').searchParams.get('cursor') ?? '0')
          return cursor < 7
            ? {
                items: [{ id: 'task-7', type: 'task', version: 2, modifiedAt: 1000, size: 10 }],
                deleted: [],
                hasMore: false,
                nextCursor: 24
              }
            : { items: [], deleted: [], hasMore: false, nextCursor: 24 }
        }
      )
      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        items: [
          {
            id: 'task-7',
            type: 'task',
            operation: 'update',
            cryptoVersion: 1,
            blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
            signature: 'sig',
            signerDeviceId: 'device-b',
            clock: { 'device-b': 2 }
          }
        ]
      })
      vi.spyOn(await import('./decrypt'), 'decryptItemFromPull').mockReturnValue({
        content: skippedUpdate,
        verified: true
      })
      vi.spyOn(await import('./initial-seed'), 'runInitialSeed').mockImplementation(() => {})
      const { ItemApplier } = await import('./apply-item')
      const applySpy = vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('applied')

      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)
      engine.setStateValue('lastCursor', '24')

      await engine.fullSync()

      expect(applySpy.mock.calls.map(([input]) => input)).toEqual([
        expect.objectContaining({ itemId: 'task-7', type: 'task', content: skippedUpdate })
      ])
      expect(engine.getStateValue('lastCursor')).toBe('24')
      expect(engine.getStateValue('cursorSkipRepair')).toBe('done')

      applySpy.mockClear()
      await engine.fullSync()
      expect(applySpy).not.toHaveBeenCalled()

      vi.restoreAllMocks()
    })
  })

  describe('#given a runtime adapter registry that omits a record type #when fullSync seeds', () => {
    it('#then still seeds every registered handler type', async () => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })

      const initialSeedModule = await import('./initial-seed')
      const seedSpy = vi.spyOn(initialSeedModule, 'runInitialSeed').mockImplementation(() => {})

      const { createSyncAdapterRegistry } = await import('@memry/sync-core')
      const { getRemoteSyncAdapter, getAllRemoteSyncAdapters } = await import('./item-handlers')
      const deps = {
        ...createMockDeps(getDb()),
        // The real runtime registry once omitted tag_category. Seeding must not
        // inherit that gap, or clock-less rows never leave the device.
        adapters: createSyncAdapterRegistry([
          { type: 'task' as const, kind: 'record' as const, remote: getRemoteSyncAdapter('task') }
        ])
      }
      const engine = new SyncEngine(deps)

      await engine.fullSync()

      // Mirror what runInitialSeed does with its argument: an omitted list means
      // the complete handler registry, a passed list is the whole seed set.
      const seedArgs = seedSpy.mock.calls[0]?.[0]
      const seededTypes = (seedArgs?.adapters ?? getAllRemoteSyncAdapters()).map(
        (adapter) => adapter.type
      )
      expect(seededTypes).toContain('tag_category')

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

  describe('#given requestCancel (close during initial sync, #1830 follow-up)', () => {
    it('#then aborts the active cycle and later cycles cannot restart pulls', async () => {
      const getSpy = vi
        .spyOn(await import('./http-client'), 'getFromServer')
        .mockResolvedValue({ items: [], deleted: [], hasMore: false, nextCursor: 0 })
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      // A cycle is running and holds a fresh controller.
      const abortController = new AbortController()
      engine['ctx'].syncing = true
      engine['ctx'].abortController = abortController

      engine.requestCancel()

      expect(abortController.signal.aborted).toBe(true)

      // The latch is the point: every later cycle opens a FRESH controller, so
      // aborting alone would let the manifest re-pull and follow-up pushes
      // restart pulls against a runtime teardown is trying to stop.
      engine['ctx'].syncing = false
      engine['ctx'].abortController = null
      deps.queue.enqueue({ type: 'task', itemId: 'task-1', operation: 'create', payload: '{}' })
      await engine.pull()
      await engine.push()

      expect(getSpy).not.toHaveBeenCalled()
      expect(deps.queue.getPendingCount()).toBe(1)

      await engine.stop()
      vi.restoreAllMocks()
    })

    it('#then a close mid-initial-pull stops between pages instead of running the pull out', async () => {
      vi.useFakeTimers()
      let changePages = 0
      const getSpy = vi
        .spyOn(await import('./http-client'), 'getFromServer')
        .mockImplementation(async (path: string) => {
          // One page per timer slice: the vault streams in slowly, like a real
          // fresh-vault pull. Only the change feed counts as pull progress;
          // the device-status probe and the manifest check share this transport.
          await new Promise((resolve) => setTimeout(resolve, 10))
          if (path.startsWith('/sync/changes')) {
            changePages++
            return { items: [], deleted: [], hasMore: true, nextCursor: changePages }
          }
          return { items: [], deleted: [], hasMore: false, nextCursor: 0 }
        })
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      const startPromise = engine.start()
      await vi.advanceTimersByTimeAsync(60)
      expect(changePages).toBeGreaterThanOrEqual(2)

      // The user closes the vault here — seconds into a minutes-long pull.
      engine.requestCancel()

      await vi.advanceTimersByTimeAsync(200)
      await startPromise

      // The pull stopped at the first boundary after the abort (the one page
      // already in flight may land), and nothing restarted it afterwards —
      // neither the manifest re-pull path nor the periodic tick.
      const pagesAfterCancel = changePages
      await vi.advanceTimersByTimeAsync(120_000)
      expect(changePages).toBe(pagesAfterCancel)

      await engine.stop()
      vi.useRealTimers()
      vi.restoreAllMocks()
    })
  })
})
