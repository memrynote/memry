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
   * through `SyncEngine.hasUnverifiedRemoteCrdtUpdate` to pick an endpoint. Both
   * halves had tests, and both suites stubbed the other side — so replacing the
   * engine method with `return false` disabled the entire fix in production and
   * left all 151 sync test files green. These drive a real coordinator, a real
   * `PullCoordinator.resolveDeviceKey` and the real bridge, with no mock
   * standing between the flag being raised and the flag being read.
   */
  describe('#given a CRDT pull whose signer device key cannot be resolved', () => {
    const crdtProviderStub = (): Record<string, ReturnType<typeof vi.fn>> => ({
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
        updates: [
          { sequenceNum: 7, data: 'eA==', createdAt: 1, signerDeviceId: 'revoked-device' }
        ],
        hasMore: false
      })

      // #when — the exact entry point drainPendingCrdtNotes uses before it
      // decides to push
      await engine.mergeRemoteCrdtForNote('note-1')

      // #then a `return false` here sends the note back to /sync/crdt/snapshot,
      // whose pruneUpdatesBeforeSnapshot deletes the row that was just skipped.
      expect(engine.hasUnverifiedRemoteCrdtUpdate('note-1')).toBe(true)

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
      expect(engine.hasUnverifiedRemoteCrdtUpdate('note-2')).toBe(false)

      vi.restoreAllMocks()
    })
  })
})
