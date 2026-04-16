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
})
