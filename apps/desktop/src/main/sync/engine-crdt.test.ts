import { describe, it, expect, vi } from 'vitest'
import { SyncEngine, type SyncEngineDeps } from './engine'
import { createMockDeps, setupTestDb } from '@tests/utils/engine-mocks'

describe('SyncEngine', () => {
  const { getDb } = setupTestDb()

  describe('#given engine with crdtProvider and CREATE note queued #when push called', () => {
    it('#then pushes CRDT snapshot BEFORE posting sync items to server', async () => {
      const callOrder: string[] = []

      const mockCrdtProvider = {
        pushSnapshotForNote: vi.fn().mockImplementation(async () => {
          callOrder.push('pushSnapshot')
          return true
        })
      }

      const deps = createMockDeps(getDb(), {
        crdtProvider: mockCrdtProvider as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'note',
        itemId: 'note-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Test Note' })
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

      vi.spyOn(await import('./http-client'), 'postToServer').mockImplementation(async () => {
        callOrder.push('postToServer')
        return {
          accepted: ['note-1'],
          rejected: [],
          serverTime: Math.floor(Date.now() / 1000),
          maxCursor: 1
        }
      })

      await engine.push()

      expect(mockCrdtProvider.pushSnapshotForNote).toHaveBeenCalledWith('note-1')
      expect(callOrder).toEqual(['pushSnapshot', 'postToServer'])

      vi.restoreAllMocks()
    })

    it('#then pushes CRDT snapshot for journal CREATE items too', async () => {
      const mockCrdtProvider = {
        pushSnapshotForNote: vi.fn().mockResolvedValue(true)
      }

      const deps = createMockDeps(getDb(), {
        crdtProvider: mockCrdtProvider as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'journal',
        itemId: 'journal-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Daily Entry' })
      })

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockReturnValue({
        pushItem: {
          id: 'journal-1',
          type: 'journal',
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
        accepted: ['journal-1'],
        rejected: [],
        serverTime: Math.floor(Date.now() / 1000),
        maxCursor: 1
      })

      await engine.push()

      expect(mockCrdtProvider.pushSnapshotForNote).toHaveBeenCalledWith('journal-1')

      vi.restoreAllMocks()
    })
  })

  describe('#given engine with crdtProvider and UPDATE note queued #when push called', () => {
    it('#then does NOT push CRDT snapshot (only CREATEs trigger snapshot)', async () => {
      const mockCrdtProvider = {
        pushSnapshotForNote: vi.fn().mockResolvedValue(true)
      }

      const deps = createMockDeps(getDb(), {
        crdtProvider: mockCrdtProvider as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'note',
        itemId: 'note-1',
        operation: 'update',
        payload: JSON.stringify({ title: 'Updated' })
      })

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockReturnValue({
        pushItem: {
          id: 'note-1',
          type: 'note',
          operation: 'update',
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
        serverTime: Math.floor(Date.now() / 1000),
        maxCursor: 1
      })

      await engine.push()

      expect(mockCrdtProvider.pushSnapshotForNote).not.toHaveBeenCalled()

      vi.restoreAllMocks()
    })
  })

  describe('#given engine with crdtProvider and CREATE task queued #when push called', () => {
    it('#then does NOT push CRDT snapshot (only note/journal types trigger snapshot)', async () => {
      const mockCrdtProvider = {
        pushSnapshotForNote: vi.fn().mockResolvedValue(true)
      }

      const deps = createMockDeps(getDb(), {
        crdtProvider: mockCrdtProvider as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'New Task' })
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
        serverTime: Math.floor(Date.now() / 1000),
        maxCursor: 1
      })

      await engine.push()

      expect(mockCrdtProvider.pushSnapshotForNote).not.toHaveBeenCalled()

      vi.restoreAllMocks()
    })
  })

  describe('#given engine with crdtProvider where snapshot push fails #when push called', () => {
    it('#then still posts sync items to server (snapshot failure is non-blocking)', async () => {
      const mockCrdtProvider = {
        pushSnapshotForNote: vi.fn().mockRejectedValue(new Error('network timeout'))
      }

      const deps = createMockDeps(getDb(), {
        crdtProvider: mockCrdtProvider as unknown as SyncEngineDeps['crdtProvider']
      })
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

      const mockPost = vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['note-1'],
        rejected: [],
        serverTime: Math.floor(Date.now() / 1000),
        maxCursor: 1
      })

      await engine.push()

      expect(mockCrdtProvider.pushSnapshotForNote).toHaveBeenCalledWith('note-1')
      expect(mockPost).toHaveBeenCalled()
      expect(deps.queue.getPendingCount()).toBe(0)

      vi.restoreAllMocks()
    })
  })

  describe('#given engine with crdtProvider and mixed batch #when push called', () => {
    it('#then only pushes CRDT snapshots for CREATE note/journal items in batch', async () => {
      const mockCrdtProvider = {
        pushSnapshotForNote: vi.fn().mockResolvedValue(true)
      }

      const deps = createMockDeps(getDb(), {
        crdtProvider: mockCrdtProvider as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'note',
        itemId: 'note-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'New Note' })
      })
      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'New Task' })
      })
      deps.queue.enqueue({
        type: 'note',
        itemId: 'note-2',
        operation: 'update',
        payload: JSON.stringify({ title: 'Updated Note' })
      })
      deps.queue.enqueue({
        type: 'journal',
        itemId: 'journal-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Entry' })
      })

      let encryptCallCount = 0
      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockImplementation(
        (args: { id: string; type: string; operation: string }) => {
          encryptCallCount++
          return {
            pushItem: {
              id: args.id,
              type: args.type,
              operation: args.operation,
              encryptedKey: 'ek',
              keyNonce: 'kn',
              encryptedData: 'ed',
              dataNonce: 'dn',
              signature: 'sig',
              signerDeviceId: 'device-1'
            },
            sizeBytes: 100
          }
        }
      )

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['note-1', 'task-1', 'note-2', 'journal-1'],
        rejected: [],
        serverTime: Math.floor(Date.now() / 1000),
        maxCursor: 1
      })

      await engine.push()

      expect(mockCrdtProvider.pushSnapshotForNote).toHaveBeenCalledTimes(2)
      expect(mockCrdtProvider.pushSnapshotForNote).toHaveBeenCalledWith('note-1')
      expect(mockCrdtProvider.pushSnapshotForNote).toHaveBeenCalledWith('journal-1')

      vi.restoreAllMocks()
    })
  })

  /**
   * The wire between the two halves of the #1489 fix.
   *
   * `CrdtSyncCoordinator` raises the flag and the CRDT snapshot push fn reads it
   * through `SyncEngine.hasUnmergedRemoteCrdtState` to pick an endpoint. Both
   * halves had tests, and both suites stubbed the other side — so replacing the
   * engine method with `return false` disabled the entire fix in production and
   * left all 151 sync test files green. These drive a real coordinator, a real
   * `PullCoordinator.resolveDeviceKey` and the real bridge, with no mock
   * standing between the flag being raised and the flag being read.
   */
  describe('#given a CRDT pull whose signer device key cannot be resolved', () => {
    const crdtProviderStub = (): Record<string, ReturnType<typeof vi.fn>> => ({
      isNoteLocalOnly: vi.fn(() => false),
      getDoc: vi.fn().mockReturnValue(undefined),
      open: vi.fn().mockResolvedValue({}),
      closeIfInactive: vi.fn().mockResolvedValue(true),
      applyRemoteUpdate: vi.fn(),
      getStateVector: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4])),
      seedFromMarkdownPublic: vi.fn()
    })

    it('#then the engine reports the note as holding unverified server state', async () => {
      const deps = createMockDeps(getDb(), {
        crdtProvider: crdtProviderStub() as unknown as SyncEngineDeps['crdtProvider'],
        // The production trigger, unmocked from here down: a revoked peer is
        // absent from GET /auth/devices, so its key resolves to null forever.
        getDevicePublicKey: vi.fn().mockResolvedValue(null)
      })
      const engine = new SyncEngine(deps)

      vi.spyOn(await import('./http-client'), 'fetchCrdtSnapshot').mockResolvedValue(null)
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        updates: [{ sequenceNum: 7, data: 'eA==', createdAt: 1, signerDeviceId: 'revoked-device' }],
        hasMore: false
      })

      // #when — the exact entry point drainPendingCrdtNotes uses before it
      // decides to push
      await engine.mergeRemoteCrdtForNote('note-1')

      // #then a `return false` here sends the note back to /sync/crdt/snapshot,
      // whose pruneUpdatesBeforeSnapshot deletes the row that was just skipped.
      expect(engine.hasUnmergedRemoteCrdtState('note-1')).toBe(true)

      vi.restoreAllMocks()
    })

    it('#then a `crdt_updated` broadcast marks the note before its pull runs', async () => {
      const deps = createMockDeps(getDb(), {
        crdtProvider: crdtProviderStub() as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)

      // #when the server tells this device a peer wrote the note. The handler is
      // private and only bound inside `start()`, which brings up the socket, so
      // this drives the branch directly rather than standing the socket up.
      ;(engine as unknown as { handleWsMessage: (message: unknown) => void }).handleWsMessage({
        type: 'crdt_updated',
        payload: { noteId: 'note-ws' }
      })

      // #then the note is unmerged from this moment, not from whenever
      // `scheduleSync` gets around to the pull. In between, the 30s snapshot
      // scheduler would otherwise push a snapshot and prune the very update the
      // broadcast announced — #1503 with the server itself as the witness.
      expect(engine.hasUnmergedRemoteCrdtState('note-ws')).toBe(true)

      vi.restoreAllMocks()
    })

    it('#then a note whose signers all resolve is not flagged', async () => {
      const deps = createMockDeps(getDb(), {
        crdtProvider: crdtProviderStub() as unknown as SyncEngineDeps['crdtProvider'],
        getDevicePublicKey: vi.fn().mockResolvedValue(new Uint8Array(32))
      })
      const engine = new SyncEngine(deps)

      vi.spyOn(await import('./http-client'), 'fetchCrdtSnapshot').mockResolvedValue(null)
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        updates: [{ sequenceNum: 7, data: 'eA==', createdAt: 1, signerDeviceId: 'device-1' }],
        hasMore: false
      })
      vi.spyOn(await import('./crdt-encrypt'), 'decryptCrdtUpdate').mockReturnValue(
        new Uint8Array([9])
      )

      // #when
      await engine.mergeRemoteCrdtForNote('note-2')

      // #then the safe route has to stay the exception — a bridge hard-wired to
      // `true` would cost every note in the vault its compaction point.
      expect(engine.hasUnmergedRemoteCrdtState('note-2')).toBe(false)

      vi.restoreAllMocks()
    })
  })

  /**
   * The worker decrypt path's result alignment. Worker replies tag each
   * decrypted payload with the ORIGINAL entry index, and entries whose signer
   * cannot be resolved are filtered out before the request — so the indexes
   * arrive with gaps. Mapping results back by array position instead of by
   * index handed later payloads another entry's bytes or `undefined`, which
   * aborted the whole pass where a revoked peer used to cost one skipped
   * update.
   */
  describe('#given CRDT payloads decrypted through the crypto worker', () => {
    const marker = (index: number): Uint8Array => new Uint8Array([10 + index])

    /** Replies exactly like the real worker: per-item results tagged r.index. */
    const workerBridgeStub = (): {
      isRunning: boolean
      decryptCrdtBatch: ReturnType<typeof vi.fn>
    } => ({
      isRunning: true,
      decryptCrdtBatch: vi.fn(async (items: Array<{ index: number }>) => ({
        results: items.map((item) => ({ index: item.index, update: marker(item.index) })),
        failures: []
      }))
    })

    const signerAwareKeyResolver = (): ((deviceId: string) => Promise<Uint8Array | null>) =>
      vi.fn((deviceId: string) =>
        Promise.resolve(deviceId === 'device-revoked' ? null : new Uint8Array(32))
      )

    // The batch apply sub-chunks at this, so the stub has to carry it —
    // `Math.min(undefined, 100)` is NaN and would silently slice nothing.
    const crdtProviderStub = (applyRemoteUpdate: ReturnType<typeof vi.fn>) =>
      ({
        inactiveDocCapacity: 32,
        isNoteLocalOnly: vi.fn(() => false),
        getDoc: vi.fn().mockReturnValue(undefined),
        open: vi.fn().mockResolvedValue({}),
        closeIfInactive: vi.fn().mockResolvedValue(true),
        applyRemoteUpdate,
        getStateVector: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4])),
        seedFromMarkdownPublic: vi.fn()
      }) as unknown as SyncEngineDeps['crdtProvider']

    it('#then a single-note pull skips an unresolved-signer update without misaligning the good ones', async () => {
      const applyRemoteUpdate = vi.fn()
      const deps = createMockDeps(getDb(), {
        crdtProvider: crdtProviderStub(applyRemoteUpdate),
        workerBridge: workerBridgeStub() as unknown as SyncEngineDeps['workerBridge'],
        getDevicePublicKey: signerAwareKeyResolver()
      })
      const engine = new SyncEngine(deps)

      vi.spyOn(await import('./http-client'), 'fetchCrdtSnapshot').mockResolvedValue(null)
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        updates: [
          { sequenceNum: 1, data: 'ZzE=', createdAt: 1, signerDeviceId: 'device-good' },
          { sequenceNum: 2, data: 'YmFk', createdAt: 2, signerDeviceId: 'device-revoked' },
          { sequenceNum: 3, data: 'ZzI=', createdAt: 3, signerDeviceId: 'device-good' }
        ],
        hasMore: false
      })

      // #when — the middle entry's signer is unresolvable (a revoked device),
      // leaving a gap in the payload indexes sent to the worker.
      await expect(engine.mergeRemoteCrdtForNote('note-1')).resolves.toBe(true)

      // #then both good updates applied with their OWN bytes and only the bad
      // one skipped. Position-mapped results would hand the third update
      // `undefined` and abort the pass.
      expect(
        applyRemoteUpdate.mock.calls.map(([noteId, update]) => [noteId, Array.from(update)])
      ).toEqual([
        ['note-1', [10]],
        ['note-1', [12]]
      ])

      vi.restoreAllMocks()
    })

    it('#then a batch pull aligns worker results across a filtered-signer gap too', async () => {
      const applyRemoteUpdate = vi.fn()
      const deps = createMockDeps(getDb(), {
        crdtProvider: crdtProviderStub(applyRemoteUpdate),
        workerBridge: workerBridgeStub() as unknown as SyncEngineDeps['workerBridge'],
        getDevicePublicKey: signerAwareKeyResolver()
      })
      const engine = new SyncEngine(deps)
      ;(engine as unknown as { ctx: { abortController: AbortController } }).ctx.abortController =
        new AbortController()

      // Cold vault: no watermarks, so no probe POST runs — the first batch
      // POST below IS the apply round.
      vi.spyOn(await import('./http-client'), 'fetchCrdtSnapshot').mockResolvedValue(null)
      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        notes: {
          'note-a': {
            updates: [{ sequenceNum: 1, data: 'x', createdAt: 1, signerDeviceId: 'device-good' }],
            hasMore: false
          },
          'note-b': {
            updates: [
              { sequenceNum: 2, data: 'y', createdAt: 2, signerDeviceId: 'device-revoked' }
            ],
            hasMore: false
          },
          'note-c': {
            updates: [{ sequenceNum: 3, data: 'z', createdAt: 3, signerDeviceId: 'device-good' }],
            hasMore: false
          }
        }
      })

      const coordinator = (
        engine as unknown as { crdtSync: { pullCrdtForNotes: (ids: string[]) => Promise<unknown> } }
      ).crdtSync

      // #when — roundEntries order is a(0), b(1), c(2); b is filtered before
      // the worker sees it, so the reply carries indexes 0 and 2 only.
      await expect(
        coordinator.pullCrdtForNotes(['note-a', 'note-b', 'note-c'])
      ).resolves.toBeDefined()

      // #then — a got index 0's bytes, c got index 2's bytes, b was skipped.
      expect(
        applyRemoteUpdate.mock.calls.map(([noteId, update]) => [noteId, Array.from(update)])
      ).toEqual([
        ['note-a', [10]],
        ['note-c', [12]]
      ])

      vi.restoreAllMocks()
    })

    it('#then a transport-level worker reject falls back to byte-identical main-thread decrypt', async () => {
      const decryptSpy = vi
        .spyOn(await import('./crdt-encrypt'), 'decryptCrdtUpdate')
        .mockReturnValue(new Uint8Array([7]))
      const bridge = {
        isRunning: true,
        decryptCrdtBatch: vi.fn().mockRejectedValue(new Error('worker thread died'))
      }
      const applyRemoteUpdate = vi.fn()
      const deps = createMockDeps(getDb(), {
        crdtProvider: crdtProviderStub(applyRemoteUpdate),
        workerBridge: bridge as unknown as SyncEngineDeps['workerBridge']
      })
      const engine = new SyncEngine(deps)

      vi.spyOn(await import('./http-client'), 'fetchCrdtSnapshot').mockResolvedValue(null)
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        updates: [{ sequenceNum: 5, data: 'eA==', createdAt: 1, signerDeviceId: 'device-good' }],
        hasMore: false
      })

      // #when — the worker transport rejects mid-flight
      await expect(engine.mergeRemoteCrdtForNote('note-1')).resolves.toBe(true)

      // #then the main-thread path produced the result, byte for byte what an
      // always-inline pass would have applied.
      expect(bridge.decryptCrdtBatch).toHaveBeenCalledTimes(1)
      expect(decryptSpy).toHaveBeenCalledTimes(1)
      expect(applyRemoteUpdate).toHaveBeenCalledWith('note-1', new Uint8Array([7]))

      vi.restoreAllMocks()
    })
  })
})
