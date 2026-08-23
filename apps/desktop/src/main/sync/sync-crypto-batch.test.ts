import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  decryptSingleItem: vi.fn(),
  encryptItemForPush: vi.fn(),
  logger: {
    error: vi.fn()
  },
  markFailed: vi.fn(),
  toBase64: vi.fn((key: Uint8Array) => `b64:${key[0]}`)
}))

vi.mock('libsodium-wrappers-sumo', () => ({
  default: {
    to_base64: mocks.toBase64,
    base64_variants: { ORIGINAL: 0 }
  }
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => mocks.logger
}))

vi.mock('./encrypt', () => ({
  encryptItemForPush: mocks.encryptItemForPush
}))

vi.mock('./decrypt-item', () => ({
  decryptSingleItem: mocks.decryptSingleItem
}))

import { decryptPullBatch, encryptPushBatch } from './sync-crypto-batch'
import { ItemTooLargeError } from '@memry/sync-client/note-size'

const vaultKey = new Uint8Array([1, 2, 3])
const signingSecretKey = new Uint8Array([4, 5, 6])

const queueRow = {
  id: 'queue-1',
  itemId: 'note-1',
  type: 'note',
  operation: 'upsert',
  payload: '{"title":"Note"}'
}

const pullItem = {
  id: 'note-1',
  type: 'note',
  operation: 'upsert',
  cryptoVersion: undefined,
  blob: {
    encryptedKey: 'ek',
    keyNonce: 'kn',
    encryptedData: 'ed',
    dataNonce: 'dn'
  },
  signature: 'sig',
  signerDeviceId: 'device-1',
  deletedAt: undefined,
  clock: { note: 1 },
  stateVector: 'sv'
} as const

describe('sync crypto batch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.setSystemTime(new Date('2026-05-10T12:00:00.000Z'))
    mocks.encryptItemForPush.mockReturnValue({ pushItem: { encrypted: true } })
    mocks.decryptSingleItem.mockReturnValue({ ok: true, item: { id: 'note-1', content: 'plain' } })
  })

  it('encrypts on the main thread with resolved payload metadata and delete timestamps', async () => {
    const result = await encryptPushBatch(
      [{ ...queueRow, operation: 'delete' }],
      vaultKey,
      signingSecretKey,
      'device-1',
      {
        queue: { markFailed: mocks.markFailed } as never,
        extractPayloadMetadata: (payload) => ({
          clock: { note: payload.length },
          stateVector: 'state-vector'
        }),
        resolvePushPayload: (item, deviceId) => `${deviceId}:${item.payload}`
      }
    )

    expect(result).toEqual([{ queueId: 'queue-1', pushItem: { encrypted: true } }])
    expect(mocks.encryptItemForPush).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'note-1',
        type: 'note',
        operation: 'delete',
        signerDeviceId: 'device-1',
        clock: { note: 'device-1:{"title":"Note"}'.length },
        stateVector: 'state-vector',
        deletedAt: 1778414400
      })
    )
  })

  it('uses the worker bridge when available and marks worker encrypt failures', async () => {
    const workerBridge = {
      isRunning: true,
      encryptBatch: vi.fn().mockResolvedValue({
        results: [{ queueId: 'queue-ok', pushItem: { ok: true } }],
        errors: [{ queueId: 'queue-bad', itemId: 'task-1', error: 'boom' }]
      })
    }

    const result = await encryptPushBatch([queueRow], vaultKey, signingSecretKey, 'device-1', {
      workerBridge: workerBridge as never,
      queue: { markFailed: mocks.markFailed } as never,
      extractPayloadMetadata: () => ({ clock: { a: 1 } }),
      resolvePushPayload: (item) => item.payload
    })

    expect(workerBridge.encryptBatch).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          queueId: 'queue-1',
          itemId: 'note-1',
          clock: { a: 1 }
        })
      ],
      vaultKey,
      signingSecretKey,
      'device-1'
    )
    expect(mocks.markFailed).toHaveBeenCalledWith('queue-bad', 'Encrypt failed: boom')
    expect(mocks.logger.error).toHaveBeenCalledWith('Push: worker encrypt failed', {
      itemId: 'task-1',
      error: 'boom'
    })
    expect(result).toEqual([{ queueId: 'queue-ok', pushItem: { ok: true } }])
  })

  it('reports a worker encrypt-cap rejection to the caller, not just to the queue row', async () => {
    const onItemTooLarge = vi.fn()
    const workerBridge = {
      isRunning: true,
      encryptBatch: vi.fn().mockResolvedValue({
        results: [],
        errors: [
          {
            queueId: 'queue-1',
            itemId: 'note-1',
            error: 'Item too large for sync (estimated 22.9MB, max 5MB)',
            code: 'item_too_large'
          }
        ]
      })
    }

    const result = await encryptPushBatch([queueRow], vaultKey, signingSecretKey, 'device-1', {
      workerBridge: workerBridge as never,
      queue: { markFailed: mocks.markFailed } as never,
      extractPayloadMetadata: () => ({}),
      resolvePushPayload: (item) => item.payload,
      onItemTooLarge
    })

    expect(onItemTooLarge).toHaveBeenCalledWith({
      itemId: 'note-1',
      type: 'note',
      payload: '{"title":"Note"}'
    })
    expect(mocks.markFailed).toHaveBeenCalledWith(
      'queue-1',
      'Encrypt failed: Item too large for sync (estimated 22.9MB, max 5MB)'
    )
    expect(result).toEqual([])
  })

  it('leaves an ordinary worker encrypt failure unreported to the caller', async () => {
    const onItemTooLarge = vi.fn()
    const workerBridge = {
      isRunning: true,
      encryptBatch: vi.fn().mockResolvedValue({
        results: [],
        errors: [{ queueId: 'queue-1', itemId: 'note-1', error: 'boom' }]
      })
    }

    await encryptPushBatch([queueRow], vaultKey, signingSecretKey, 'device-1', {
      workerBridge: workerBridge as never,
      queue: { markFailed: mocks.markFailed } as never,
      extractPayloadMetadata: () => ({}),
      resolvePushPayload: (item) => item.payload,
      onItemTooLarge
    })

    expect(onItemTooLarge).not.toHaveBeenCalled()
    expect(mocks.markFailed).toHaveBeenCalledWith('queue-1', 'Encrypt failed: boom')
  })

  it('isolates a main-thread encrypt-cap rejection so the rest of the batch still pushes', async () => {
    const onItemTooLarge = vi.fn()
    mocks.encryptItemForPush.mockImplementation((input: { id: string }) => {
      if (input.id === 'note-big') {
        throw new ItemTooLargeError('note-big', 24_000_000, 5 * 1024 * 1024)
      }
      return { pushItem: { encrypted: true } }
    })

    const result = await encryptPushBatch(
      [
        { ...queueRow, id: 'queue-big', itemId: 'note-big', payload: '{"title":"Log dump"}' },
        queueRow
      ],
      vaultKey,
      signingSecretKey,
      'device-1',
      {
        queue: { markFailed: mocks.markFailed } as never,
        extractPayloadMetadata: () => ({}),
        resolvePushPayload: (item) => item.payload,
        onItemTooLarge
      }
    )

    expect(onItemTooLarge).toHaveBeenCalledWith({
      itemId: 'note-big',
      type: 'note',
      payload: '{"title":"Log dump"}'
    })
    expect(mocks.markFailed).toHaveBeenCalledWith(
      'queue-big',
      expect.stringContaining('Item too large for sync')
    )
    expect(result).toEqual([{ queueId: 'queue-1', pushItem: { encrypted: true } }])
  })

  it('decrypts on the main thread and records missing signer keys and crypto failures', async () => {
    mocks.decryptSingleItem
      .mockReturnValueOnce({ ok: false, failure: { id: 'note-1', error: 'bad sig' } })
      .mockReturnValueOnce({ ok: true, item: { id: 'note-2' } })

    const result = await decryptPullBatch(
      [
        pullItem,
        { ...pullItem, id: 'note-missing', signerDeviceId: 'missing' },
        { ...pullItem, id: 'note-2' }
      ] as never,
      vaultKey,
      {
        resolveDeviceKey: vi.fn(async (deviceId) =>
          deviceId === 'missing' ? null : new Uint8Array([9])
        )
      }
    )

    expect(result.decrypted).toEqual([{ id: 'note-2' }])
    expect(result.failures).toEqual([
      { id: 'note-1', error: 'bad sig' },
      expect.objectContaining({
        id: 'note-missing',
        signerDeviceId: 'missing',
        error: 'No public key for signer device missing',
        isCryptoError: false,
        isSignatureError: false
      })
    ])
  })

  it('decrypts through the worker bridge and skips items without signer keys', async () => {
    const workerBridge = {
      isRunning: true,
      decryptBatch: vi.fn().mockResolvedValue({
        results: [{ id: 'note-1', content: 'plain' }],
        failures: [{ id: 'note-2', error: 'decrypt failed' }]
      })
    }

    const result = await decryptPullBatch(
      [
        pullItem,
        { ...pullItem, id: 'note-skip', signerDeviceId: 'skip' },
        { ...pullItem, id: 'note-2', signerDeviceId: 'device-2' }
      ] as never,
      vaultKey,
      {
        workerBridge: workerBridge as never,
        resolveDeviceKey: vi.fn(async (deviceId) =>
          deviceId === 'skip' ? null : new Uint8Array([deviceId === 'device-1' ? 1 : 2])
        )
      }
    )

    expect(mocks.toBase64).toHaveBeenCalledTimes(2)
    expect(workerBridge.decryptBatch).toHaveBeenCalledWith(
      [
        expect.objectContaining({ id: 'note-1', cryptoVersion: 1 }),
        expect.objectContaining({ id: 'note-2', signerDeviceId: 'device-2' })
      ],
      vaultKey,
      { 'device-1': 'b64:1', 'device-2': 'b64:2' }
    )
    expect(result.decrypted).toEqual([{ id: 'note-1', content: 'plain' }])
    expect(result.failures).toEqual([
      expect.objectContaining({ id: 'note-skip', isCryptoError: false }),
      { id: 'note-2', error: 'decrypt failed' }
    ])
  })

  it('falls back to main-thread encryption when the worker rejects the batch', async () => {
    // A version-skewed worker bundle answers an unknown kind with
    // { type: 'error' }, which the bridge turns into a rejection.
    const workerBridge = {
      isRunning: true,
      encryptBatch: vi
        .fn()
        .mockRejectedValue(new Error('Unsupported worker message kind: encrypt-batch'))
    }

    const result = await encryptPushBatch([queueRow], vaultKey, signingSecretKey, 'device-1', {
      workerBridge: workerBridge as never,
      queue: { markFailed: mocks.markFailed } as never,
      extractPayloadMetadata: () => ({ clock: { a: 1 }, stateVector: 'sv' }),
      resolvePushPayload: (item) => item.payload
    })

    expect(result).toEqual([{ queueId: 'queue-1', pushItem: { encrypted: true } }])
    expect(mocks.encryptItemForPush).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'note-1', clock: { a: 1 }, stateVector: 'sv' })
    )
    expect(mocks.markFailed).not.toHaveBeenCalled()
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Push: worker crypto unavailable, falling back to main thread',
      { error: 'Unsupported worker message kind: encrypt-batch' }
    )
  })

  it('resolves the push payload once so the encrypt fallback reuses the worker payload', async () => {
    const workerBridge = {
      isRunning: true,
      encryptBatch: vi.fn().mockRejectedValue(new Error('Worker exited with code 1'))
    }
    const resolvePushPayload = vi.fn((item: { payload: string }) => item.payload)

    await encryptPushBatch([queueRow], vaultKey, signingSecretKey, 'device-1', {
      workerBridge: workerBridge as never,
      queue: { markFailed: mocks.markFailed } as never,
      extractPayloadMetadata: () => ({}),
      resolvePushPayload: resolvePushPayload as never
    })

    // Re-resolving would read live DB rows again and could hand the fallback a
    // different payload than the worker was asked to encrypt.
    expect(resolvePushPayload).toHaveBeenCalledTimes(1)
    expect(workerBridge.encryptBatch.mock.calls[0][0]).toEqual([
      expect.objectContaining({ payload: queueRow.payload })
    ])
    expect(mocks.encryptItemForPush).toHaveBeenCalledWith(expect.objectContaining({ id: 'note-1' }))
  })

  it('falls back to main-thread decryption when the worker rejects the batch', async () => {
    mocks.decryptSingleItem.mockReturnValue({ ok: true, item: { id: 'note-1', content: 'plain' } })
    const workerBridge = {
      isRunning: true,
      decryptBatch: vi.fn().mockRejectedValue(new Error('Worker exited with code 1'))
    }

    const result = await decryptPullBatch(
      [pullItem, { ...pullItem, id: 'note-skip', signerDeviceId: 'skip' }] as never,
      vaultKey,
      {
        workerBridge: workerBridge as never,
        resolveDeviceKey: vi.fn(async (deviceId) =>
          deviceId === 'skip' ? null : new Uint8Array([9])
        )
      }
    )

    expect(mocks.decryptSingleItem).toHaveBeenCalledTimes(1)
    expect(result.decrypted).toEqual([{ id: 'note-1', content: 'plain' }])
    // The skipped item is re-derived by the fallback loop, not duplicated.
    expect(result.failures).toEqual([
      expect.objectContaining({ id: 'note-skip', signerDeviceId: 'skip' })
    ])
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Pull: worker crypto unavailable, falling back to main thread',
      { error: 'Worker exited with code 1' }
    )
  })

  // A bridge that has latched itself off reports isRunning false. These two pin
  // the other half of that contract: a false gate must take the main-thread path
  // outright, never paying a worker round trip to rediscover it is broken.
  it('encrypts on the main thread without a worker request when the bridge is not running', async () => {
    const workerBridge = { isRunning: false, encryptBatch: vi.fn() }

    const result = await encryptPushBatch([queueRow], vaultKey, signingSecretKey, 'device-1', {
      workerBridge: workerBridge as never,
      queue: { markFailed: mocks.markFailed } as never,
      extractPayloadMetadata: () => ({}),
      resolvePushPayload: (item) => item.payload
    })

    expect(workerBridge.encryptBatch).not.toHaveBeenCalled()
    expect(mocks.encryptItemForPush).toHaveBeenCalledTimes(1)
    expect(result).toEqual([{ queueId: 'queue-1', pushItem: { encrypted: true } }])
  })

  it('decrypts on the main thread without a worker request when the bridge is not running', async () => {
    const workerBridge = { isRunning: false, decryptBatch: vi.fn() }

    const result = await decryptPullBatch([pullItem] as never, vaultKey, {
      workerBridge: workerBridge as never,
      resolveDeviceKey: vi.fn(async () => new Uint8Array([9]))
    })

    expect(workerBridge.decryptBatch).not.toHaveBeenCalled()
    expect(mocks.decryptSingleItem).toHaveBeenCalledTimes(1)
    expect(result.decrypted).toEqual([{ id: 'note-1', content: 'plain' }])
  })

  it('returns only skipped failures when every worker item lacks a signer key', async () => {
    const workerBridge = {
      isRunning: true,
      decryptBatch: vi.fn()
    }

    const result = await decryptPullBatch([pullItem] as never, vaultKey, {
      workerBridge: workerBridge as never,
      resolveDeviceKey: vi.fn(async () => null)
    })

    expect(workerBridge.decryptBatch).not.toHaveBeenCalled()
    expect(result).toEqual({
      decrypted: [],
      failures: [expect.objectContaining({ id: 'note-1', signerDeviceId: 'device-1' })]
    })
  })
})
