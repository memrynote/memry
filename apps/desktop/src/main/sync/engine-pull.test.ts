import { describe, it, expect, vi } from 'vitest'
import { SyncEngine } from './engine'
import { createMockDeps, setupTestDb } from '@tests/utils/engine-mocks'

describe('SyncEngine', () => {
  const { getDb } = setupTestDb()

  describe('#given engine pull #when posting to /sync/pull', () => {
    it('#then sends camelCase itemIds and includes deleted refs', async () => {
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [{ id: 'task-1', type: 'task', version: 1, modifiedAt: 1000, size: 10 }],
        deleted: ['task-2'],
        hasMore: false,
        nextCursor: 1
      })

      const postSpy = vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        items: []
      })

      await engine.pull()

      expect(postSpy).toHaveBeenCalledWith(
        '/sync/pull',
        { itemIds: ['task-1', 'task-2'] },
        'test-token'
      )
      vi.restoreAllMocks()
    })
  })

  describe('#given applier returns conflict #when pull receives item', () => {
    it('#then emits CONFLICT_DETECTED event', async () => {
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      const mockChanges = {
        items: [{ id: 'task-1', type: 'task', version: 1, modifiedAt: 1000, size: 50 }],
        deleted: [],
        hasMore: false,
        nextCursor: 1
      }
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue(mockChanges)

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        items: [
          {
            id: 'task-1',
            type: 'task',
            operation: 'update',
            cryptoVersion: 1,
            blob: {
              encryptedKey: 'ek',
              keyNonce: 'kn',
              encryptedData: 'ed',
              dataNonce: 'dn'
            },
            signature: 'sig',
            signerDeviceId: 'device-1',
            clock: { 'device-1': 2 }
          }
        ]
      })

      vi.spyOn(await import('./decrypt'), 'decryptItemFromPull').mockReturnValue({
        content: new TextEncoder().encode(
          JSON.stringify({ id: 'task-1', title: 'Remote', clock: { 'device-1': 2 } })
        ),
        verified: true
      })

      const { ItemApplier } = await import('./apply-item')
      vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('conflict')

      await engine.pull()

      expect(deps.emitToRenderer).toHaveBeenCalledWith(
        'sync:conflict-detected',
        expect.objectContaining({ itemId: 'task-1', type: 'task' })
      )

      vi.restoreAllMocks()
    })
  })

  describe('#given pull response contains tombstone #when item applied', () => {
    it('#then applies delete operation', async () => {
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        deleted: ['task-1'],
        hasMore: false,
        nextCursor: 1
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        items: [
          {
            id: 'task-1',
            type: 'task',
            operation: 'delete',
            cryptoVersion: 1,
            blob: {
              encryptedKey: 'ek',
              keyNonce: 'kn',
              encryptedData: 'ed',
              dataNonce: 'dn'
            },
            signature: 'sig',
            signerDeviceId: 'device-1',
            deletedAt: 1700000000,
            clock: { 'device-1': 2 }
          }
        ]
      })

      vi.spyOn(await import('./decrypt'), 'decryptItemFromPull').mockReturnValue({
        content: new TextEncoder().encode(JSON.stringify({ id: 'task-1' })),
        verified: true
      })

      const { ItemApplier } = await import('./apply-item')
      const applySpy = vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('applied')

      await engine.pull()

      expect(applySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: 'task-1',
          type: 'task',
          operation: 'delete'
        })
      )
      vi.restoreAllMocks()
    })
  })

  describe('#given full push/pull round-trip #when item queued and synced', () => {
    it('#then item is encrypted, pushed, pulled, decrypted, and applied', async () => {
      const deps = createMockDeps(getDb())
      const taskPayload = { id: 'task-1', title: 'Round trip test', projectId: 'proj-1' }
      const encodedPayload = new TextEncoder().encode(JSON.stringify(taskPayload))

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'create',
        payload: JSON.stringify(taskPayload)
      })

      const fakePushItem = {
        id: 'task-1',
        type: 'task' as const,
        operation: 'create' as const,
        encryptedKey: 'ek-base64',
        keyNonce: 'kn-base64',
        encryptedData: 'ed-base64',
        dataNonce: 'dn-base64',
        signature: 'sig-base64',
        signerDeviceId: 'device-1'
      }

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockReturnValue({
        pushItem: fakePushItem,
        sizeBytes: 128
      })

      const serverTime = Math.floor(Date.now() / 1000)
      const postMock = vi.fn()
      const getMock = vi.fn()

      postMock
        .mockResolvedValueOnce({
          accepted: ['task-1'],
          rejected: [],
          serverTime
        })
        .mockResolvedValueOnce({
          items: [
            {
              id: 'task-1',
              type: 'task',
              operation: 'create',
              cryptoVersion: 1,
              blob: {
                encryptedKey: 'ek-base64',
                keyNonce: 'kn-base64',
                encryptedData: 'ed-base64',
                dataNonce: 'dn-base64'
              },
              signature: 'sig-base64',
              signerDeviceId: 'device-1',
              clock: { 'device-1': 1 }
            }
          ]
        })

      getMock.mockResolvedValue({
        items: [{ id: 'task-1', type: 'task', version: 1, modifiedAt: 1000, size: 128 }],
        deleted: [],
        hasMore: false,
        nextCursor: 1
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockImplementation(postMock)
      vi.spyOn(await import('./http-client'), 'getFromServer').mockImplementation(getMock)

      vi.spyOn(await import('./decrypt'), 'decryptItemFromPull').mockReturnValue({
        content: encodedPayload,
        verified: true
      })

      const { ItemApplier } = await import('./apply-item')
      const applySpy = vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('applied')

      const engine = new SyncEngine(deps)
      await engine.push()
      await engine.pull()

      const encryptMod = await import('./encrypt')
      expect(encryptMod.encryptItemForPush).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'task-1', type: 'task', operation: 'create' })
      )

      expect(deps.queue.getPendingCount()).toBe(0)

      const decryptMod = await import('./decrypt')
      expect(decryptMod.decryptItemFromPull).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'task-1', type: 'task' })
      )

      expect(applySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: 'task-1',
          type: 'task',
          operation: 'create',
          content: encodedPayload
        })
      )

      const itemSyncedCalls = (deps.emitToRenderer as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[0] === 'sync:item-synced'
      )
      const pushEvents = itemSyncedCalls.filter((call) => call[1]?.operation === 'push')
      const pullEvents = itemSyncedCalls.filter((call) => call[1]?.operation === 'pull')
      expect(pushEvents).toHaveLength(1)
      expect(pullEvents).toHaveLength(1)

      vi.restoreAllMocks()
    })
  })

  describe('#given pull with unknown signer device #when pull called', () => {
    it('#then skips unknown signer items but continues pagination', async () => {
      const deps = createMockDeps(getDb(), {
        getDevicePublicKey: vi.fn().mockImplementation(async (deviceId: string) => {
          if (deviceId === 'device-1') return new Uint8Array(32)
          return null
        })
      })
      const engine = new SyncEngine(deps)

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [
          { id: 'task-1', type: 'task', version: 1, modifiedAt: 1000, size: 10 },
          { id: 'task-2', type: 'task', version: 1, modifiedAt: 1001, size: 10 }
        ],
        deleted: [],
        hasMore: false,
        nextCursor: 2
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        items: [
          {
            id: 'task-1',
            type: 'task',
            operation: 'create',
            cryptoVersion: 1,
            blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
            signature: 'sig',
            signerDeviceId: 'device-unknown'
          },
          {
            id: 'task-2',
            type: 'task',
            operation: 'create',
            cryptoVersion: 1,
            blob: { encryptedKey: 'ek2', keyNonce: 'kn2', encryptedData: 'ed2', dataNonce: 'dn2' },
            signature: 'sig2',
            signerDeviceId: 'device-1'
          }
        ]
      })

      vi.spyOn(await import('./decrypt'), 'decryptItemFromPull').mockReturnValue({
        content: new TextEncoder().encode(JSON.stringify({ id: 'task-2' })),
        verified: true
      })

      const { ItemApplier } = await import('./apply-item')
      const applySpy = vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('applied')

      await engine.pull()

      expect(applySpy).toHaveBeenCalledTimes(1)
      expect(applySpy).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'task-2' }))

      vi.restoreAllMocks()
    })
  })

  describe('#given pull with one bad item #when decrypt throws for first item', () => {
    it('#then still applies remaining items', async () => {
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [
          { id: 'task-1', type: 'task', version: 1, modifiedAt: 1000, size: 10 },
          { id: 'task-2', type: 'task', version: 1, modifiedAt: 1001, size: 10 }
        ],
        deleted: [],
        hasMore: false,
        nextCursor: 2
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        items: [
          {
            id: 'task-1',
            type: 'task',
            operation: 'create',
            cryptoVersion: 1,
            blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
            signature: 'sig',
            signerDeviceId: 'device-1',
            clock: { 'device-1': 1 }
          },
          {
            id: 'task-2',
            type: 'task',
            operation: 'create',
            cryptoVersion: 1,
            blob: { encryptedKey: 'ek2', keyNonce: 'kn2', encryptedData: 'ed2', dataNonce: 'dn2' },
            signature: 'sig2',
            signerDeviceId: 'device-1',
            clock: { 'device-1': 2 }
          }
        ]
      })

      const decryptMock = vi.spyOn(await import('./decrypt'), 'decryptItemFromPull')
      decryptMock.mockImplementationOnce(() => {
        throw new Error('base64 decode failed')
      })
      decryptMock.mockReturnValueOnce({
        content: new TextEncoder().encode(JSON.stringify({ id: 'task-2', title: 'Good' })),
        verified: true
      })

      const { ItemApplier } = await import('./apply-item')
      const applySpy = vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('applied')

      await engine.pull()

      expect(applySpy).toHaveBeenCalledTimes(1)
      expect(applySpy).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'task-2' }))
      expect(engine.currentState).not.toBe('error')

      vi.restoreAllMocks()
    })
  })

  describe('#given pull with all crypto failures #when every item throws SignatureVerificationError', () => {
    it('#then quarantines items instead of tripping circuit breaker', async () => {
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [
          { id: 'task-1', type: 'task', version: 1, modifiedAt: 1000, size: 10 },
          { id: 'task-2', type: 'task', version: 1, modifiedAt: 1001, size: 10 }
        ],
        deleted: [],
        hasMore: false,
        nextCursor: 2
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        items: [
          {
            id: 'task-1',
            type: 'task',
            operation: 'create',
            cryptoVersion: 1,
            blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
            signature: 'sig',
            signerDeviceId: 'device-1',
            clock: { 'device-1': 1 }
          },
          {
            id: 'task-2',
            type: 'task',
            operation: 'create',
            cryptoVersion: 1,
            blob: { encryptedKey: 'ek2', keyNonce: 'kn2', encryptedData: 'ed2', dataNonce: 'dn2' },
            signature: 'sig2',
            signerDeviceId: 'device-1',
            clock: { 'device-1': 2 }
          }
        ]
      })

      const { SignatureVerificationError } = await import('./decrypt')
      vi.spyOn(await import('./decrypt'), 'decryptItemFromPull').mockImplementation((input) => {
        throw new SignatureVerificationError(input.id, input.signerDeviceId)
      })

      await engine.pull()

      expect(engine.currentState).not.toBe('error')
      const quarantined = engine.getQuarantinedItems()
      expect(quarantined).toHaveLength(2)
      expect(quarantined[0].signerDeviceId).toBe('device-1')
      expect(quarantined[0].attemptCount).toBe(1)
      expect(quarantined[0].permanent).toBe(false)

      expect(deps.emitToRenderer).toHaveBeenCalledWith(
        'sync:security-warning',
        expect.objectContaining({
          reason: 'signature_verification_failed',
          itemId: expect.any(String),
          signerDeviceId: 'device-1'
        })
      )

      vi.restoreAllMocks()
    })

    it('#then permanently quarantines after 3 failures', async () => {
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      const makeServerMocks = async () => {
        vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
          items: [{ id: 'task-1', type: 'task', version: 1, modifiedAt: 1000, size: 10 }],
          deleted: [],
          hasMore: false,
          nextCursor: 2
        })

        vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
          items: [
            {
              id: 'task-1',
              type: 'task',
              operation: 'create',
              cryptoVersion: 1,
              blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
              signature: 'sig',
              signerDeviceId: 'device-1',
              clock: { 'device-1': 1 }
            }
          ]
        })

        const { SignatureVerificationError } = await import('./decrypt')
        vi.spyOn(await import('./decrypt'), 'decryptItemFromPull').mockImplementation((input) => {
          throw new SignatureVerificationError(input.id, input.signerDeviceId)
        })
      }

      await makeServerMocks()
      await engine.pull()
      vi.restoreAllMocks()

      await makeServerMocks()
      await engine.pull()
      vi.restoreAllMocks()

      await makeServerMocks()
      await engine.pull()
      vi.restoreAllMocks()

      const quarantined = engine.getQuarantinedItems()
      expect(quarantined).toHaveLength(1)
      expect(quarantined[0].attemptCount).toBe(3)
      expect(quarantined[0].permanent).toBe(true)

      await makeServerMocks()
      await engine.pull()
      vi.restoreAllMocks()

      const q2 = engine.getQuarantinedItems()
      expect(q2[0].attemptCount).toBe(3)
    })
  })

  describe('#given pull fails with 403 AUTH_DEVICE_REVOKED', () => {
    it('#then handles device revocation instead of generic error', async () => {
      const { SyncServerError } = await import('./http-client')
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)

      vi.spyOn(await import('./http-client'), 'getFromServer').mockRejectedValue(
        new SyncServerError('Forbidden', 403, 'AUTH_DEVICE_REVOKED: Device has been revoked')
      )

      await engine.pull()

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
