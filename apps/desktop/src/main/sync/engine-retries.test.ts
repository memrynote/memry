import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { SyncEngine, type SyncEngineDeps } from './engine'
import { NetworkError } from './http-client'
import type { WebSocketMessage } from './websocket'
import { createMockDeps, createMockNetwork, setupTestDb } from '@tests/utils/engine-mocks'

describe('SyncEngine', () => {
  const { getDb } = setupTestDb()

  describe('#given engine #when start called while offline', () => {
    it('#then sets state to offline', async () => {
      const network = createMockNetwork(false)
      const deps = createMockDeps(getDb(), { network })
      const engine = new SyncEngine(deps)

      await engine.start()

      expect(engine.currentState).toBe('offline')
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
      const deps = createMockDeps(getDb(), { network })
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
      const deps = createMockDeps(getDb(), { network })
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
      const deps = createMockDeps(getDb(), { network, getAccessToken })
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

  describe('#given unregistered device on startup #when start() called', () => {
    it('#then sets idle state without connecting WS or syncing', async () => {
      const deps = createMockDeps(getDb(), {
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
      const deps = createMockDeps(getDb(), {
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
      const deps = createMockDeps(getDb(), {
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
      const deps = createMockDeps(getDb(), { getSigningKeys })
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
      const deps = createMockDeps(getDb(), {
        getSigningKeys: vi.fn().mockResolvedValue(null)
      })
      const engine = new SyncEngine(deps)
      await engine.start()
      await engine.activate()

      expect(deps.ws.connect).not.toHaveBeenCalled()
      await engine.stop()
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

      const deps = createMockDeps(getDb(), {
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

  describe('#given device revoked via WS error message', () => {
    it('#then sets error state, disconnects WS, emits DEVICE_REMOVED', async () => {
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      })
      const deps = createMockDeps(getDb())
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
      const deps = createMockDeps(getDb())
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

  describe('#given device revoked #when engine is in error state', () => {
    it('#then does NOT schedule retry', async () => {
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
        const deps = createMockDeps(getDb(), { network })
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
        const deps = createMockDeps(getDb(), { network })
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
        const deps = createMockDeps(getDb(), { network })
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
        const deps = createMockDeps(getDb(), { network })
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
        const deps = createMockDeps(getDb())
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

        const deps = createMockDeps(getDb())
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

        const deps = createMockDeps(getDb())
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
        const deps = createMockDeps(getDb(), { network })
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
})
