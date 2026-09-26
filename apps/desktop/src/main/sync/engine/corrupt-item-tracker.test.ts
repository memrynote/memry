import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'
import { deleteAttestationPayload } from '@memry/contracts/delete-attestation'
import { signPayload } from '../../crypto/signatures'
import { CorruptItemTracker } from './corrupt-item-tracker'
import { CORRUPT_ITEM_COOLDOWN_MS, MAX_CORRUPT_ITEMS } from './sync-context'
import type { SyncContext } from './sync-context'
import type { QuarantineManager } from './quarantine-manager'
import { postToServer } from '../http-client'
import { decryptPullBatch } from '../sync-crypto-batch'
import { localTombstoneRefusal } from './purged-tombstone-guard'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../http-client', () => ({
  postToServer: vi.fn()
}))

vi.mock('@memry/sync-client/retry', () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => ({ value: await fn() }))
}))

vi.mock('../sync-crypto-batch', () => ({
  decryptPullBatch: vi.fn()
}))

vi.mock('./purged-tombstone-guard', () => ({
  readKnownDeviceIds: vi.fn(() => null),
  localTombstoneRefusal: vi.fn(() => null)
}))

await sodium.ready
const signer = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(5))

/** A purged tombstone entry, attested by device-a unless `attest` is false (#2408). */
const purged = (
  id: string,
  type: string,
  clock: Record<string, number>,
  serverCursor: number,
  attest = true
) => ({
  id,
  type,
  deletedAt: 5,
  clock,
  serverCursor,
  ...(attest
    ? {
        signerDeviceId: 'device-a',
        deleteAttestation: sodium.to_base64(
          signPayload(
            deleteAttestationPayload({ id, type: type as 'task', deletedAt: 5, clock }),
            CBOR_FIELD_ORDER.DELETE_ATTESTATION,
            signer.privateKey
          ),
          sodium.base64_variants.ORIGINAL
        )
      }
    : {})
})

const createTracker = (): CorruptItemTracker => {
  const ctx = {
    deps: {
      network: { online: true },
      workerBridge: undefined
    },
    abortController: null
  } as unknown as SyncContext

  const quarantine = {
    quarantineItem: vi.fn()
  } as unknown as QuarantineManager

  const resolveDeviceKey = vi.fn(async (deviceId: string) =>
    deviceId === 'device-a' ? signer.publicKey : new Uint8Array(32)
  )

  return new CorruptItemTracker(ctx, quarantine, resolveDeviceKey)
}

describe('CorruptItemTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('shouldRetry', () => {
    describe('#given unknown item #when shouldRetry called', () => {
      it('#then returns true', () => {
        const tracker = createTracker()

        const result = tracker.shouldRetry({ id: 'item-1', type: 'task' })

        expect(result).toBe(true)
      })
    })

    describe('#given recently failed item #when shouldRetry called', () => {
      it('#then returns false', () => {
        const tracker = createTracker()
        tracker.markFailed({ id: 'item-1', type: 'task' })

        const result = tracker.shouldRetry({ id: 'item-1', type: 'task' })

        expect(result).toBe(false)
      })
    })

    describe('#given failed item #when cooldown has expired', () => {
      it('#then returns true', () => {
        const tracker = createTracker()
        tracker.markFailed({ id: 'item-1', type: 'task' })

        vi.advanceTimersByTime(CORRUPT_ITEM_COOLDOWN_MS + 1)

        const result = tracker.shouldRetry({ id: 'item-1', type: 'task' })

        expect(result).toBe(true)
      })
    })
  })

  describe('markFailed', () => {
    describe('#given new item #when markFailed called', () => {
      it('#then creates entry with attempts=1', () => {
        const tracker = createTracker()

        tracker.markFailed({ id: 'item-1', type: 'task' })

        expect(tracker.shouldRetry({ id: 'item-1', type: 'task' })).toBe(false)
      })
    })

    describe('#given existing failed item #when markFailed called again', () => {
      it('#then increments attempts and item remains not retryable', () => {
        const tracker = createTracker()
        tracker.markFailed({ id: 'item-1', type: 'task' })
        tracker.markFailed({ id: 'item-1', type: 'task' })

        expect(tracker.shouldRetry({ id: 'item-1', type: 'task' })).toBe(false)
      })
    })
  })

  describe('clearExpired', () => {
    describe('#given expired and fresh entries #when clearExpired called', () => {
      it('#then removes only expired entries', () => {
        const tracker = createTracker()

        tracker.markFailed({ id: 'old-item', type: 'task' })
        vi.advanceTimersByTime(CORRUPT_ITEM_COOLDOWN_MS + 1)
        tracker.markFailed({ id: 'fresh-item', type: 'task' })

        tracker.clearExpired()

        expect(tracker.shouldRetry({ id: 'old-item', type: 'task' })).toBe(true)
        expect(tracker.shouldRetry({ id: 'fresh-item', type: 'task' })).toBe(false)
      })
    })
  })

  describe('clear', () => {
    describe('#given tracked items #when clear called', () => {
      it('#then removes all entries', () => {
        const tracker = createTracker()
        tracker.markFailed({ id: 'item-1', type: 'task' })
        tracker.markFailed({ id: 'item-2', type: 'task' })

        tracker.clear()

        expect(tracker.shouldRetry({ id: 'item-1', type: 'task' })).toBe(true)
        expect(tracker.shouldRetry({ id: 'item-2', type: 'task' })).toBe(true)
      })
    })
  })

  describe('cap enforcement', () => {
    describe('#given more failures than the cap #when markFailed called', () => {
      it('#then keeps exactly MAX_CORRUPT_ITEMS entries on cooldown', () => {
        const tracker = createTracker()

        for (let i = 0; i < MAX_CORRUPT_ITEMS + 250; i++) {
          tracker.markFailed({ id: `item-${i}`, type: 'task' })
        }

        let onCooldown = 0
        for (let i = 0; i < MAX_CORRUPT_ITEMS + 250; i++) {
          if (!tracker.shouldRetry({ id: `item-${i}`, type: 'task' })) onCooldown++
        }
        expect(onCooldown).toBe(MAX_CORRUPT_ITEMS)
      })

      it('#then evicts the coldest entries first and keeps the newest', () => {
        const tracker = createTracker()

        for (let i = 0; i < MAX_CORRUPT_ITEMS; i++) {
          tracker.markFailed({ id: `item-${i}`, type: 'task' })
        }
        // #when — one more entry pushes the map over the cap
        tracker.markFailed({ id: 'newest', type: 'task' })

        // #then — the oldest failedAt lost its cooldown, the newest kept it
        expect(tracker.shouldRetry({ id: 'item-0', type: 'task' })).toBe(true)
        expect(tracker.shouldRetry({ id: 'item-1', type: 'task' })).toBe(false)
        expect(tracker.shouldRetry({ id: 'newest', type: 'task' })).toBe(false)
      })
    })

    describe('#given a re-failed old entry #when the cap is exceeded', () => {
      it('#then the refreshed entry survives and a colder one is evicted', () => {
        const tracker = createTracker()

        for (let i = 0; i < MAX_CORRUPT_ITEMS; i++) {
          tracker.markFailed({ id: `item-${i}`, type: 'task' })
        }
        // item-0 is the coldest; failing it again must make it the hottest.
        vi.advanceTimersByTime(1000)
        tracker.markFailed({ id: 'item-0', type: 'task' })

        tracker.markFailed({ id: 'newest', type: 'task' })

        expect(tracker.shouldRetry({ id: 'item-0', type: 'task' })).toBe(false)
        expect(tracker.shouldRetry({ id: 'item-1', type: 'task' })).toBe(true)
      })
    })
  })

  describe('refetch', () => {
    describe('#given all items on cooldown #when refetch called', () => {
      it('#then returns empty recovered and permanentFailures', async () => {
        const tracker = createTracker()
        tracker.markFailed({ id: 'item-1', type: 'task' })
        tracker.markFailed({ id: 'item-2', type: 'task' })

        const result = await tracker.refetch(
          [
            { id: 'item-1', type: 'task' },
            { id: 'item-2', type: 'task' }
          ],
          'token',
          new Uint8Array(32)
        )

        // #2302 review (B-1): refs the cooldown kept from the request come back
        // as `skipped`, never silently dropped (a caller read that as "gone").
        expect(result).toEqual({
          recovered: [],
          permanentFailures: [],
          missing: [],
          invalid: [],
          blobMissing: [],
          skipped: [
            { id: 'item-1', type: 'task' },
            { id: 'item-2', type: 'task' }
          ]
        })
      })
    })

    // #2285
    describe('#given more ids than one /sync/pull accepts #when refetch runs', () => {
      it('#then it sends 100-id chunks and reports a still-invalid item apart from a missing one', async () => {
        vi.mocked(postToServer).mockClear()
        const tracker = createTracker()
        const refs = Array.from({ length: 150 }, (_, i) => ({ id: `task-${i}`, type: 'task' }))
        vi.mocked(postToServer).mockImplementation(async (_path, body) => {
          const ids = (body as { itemIds: string[] }).itemIds
          return { items: ids.includes('task-120') ? [{ id: 'task-120', type: 'task' }] : [] }
        })
        vi.mocked(decryptPullBatch).mockResolvedValue({ decrypted: [], failures: [] })

        const result = await tracker.refetch(refs, 'token', new Uint8Array(32))

        expect(
          vi
            .mocked(postToServer)
            .mock.calls.map(([, body]) => (body as { itemIds: string[] }).itemIds.length)
        ).toEqual([100, 50])
        expect(result.invalid).toEqual([{ id: 'task-120', type: 'task' }])
        expect(result.missing).toHaveLength(149)
        expect(result.missing).not.toContainEqual({ id: 'task-120', type: 'task' })
      })
    })

    describe('#given the server returns both type rows for a shared id #when refetch requested one type', () => {
      it('#then only the requested (type, id) pair is processed', async () => {
        // The pull endpoint matches bare ids across all types, so id 'inbox'
        // returns both the project and the tag_definition rows. The sibling
        // type was never corrupt and must not be decrypted or re-branded.
        const tracker = createTracker()

        const makeServerItem = (type: string) => ({
          id: 'inbox',
          type,
          operation: 'update',
          signature: 'c2ln',
          signerDeviceId: 'device-a',
          blob: {
            encryptedKey: 'a2V5',
            keyNonce: 'bm9uY2U=',
            encryptedData: 'ZGF0YQ==',
            dataNonce: 'bm9uY2Uy'
          }
        })
        vi.mocked(postToServer).mockResolvedValue({
          items: [makeServerItem('project'), makeServerItem('tag_definition')]
        })
        vi.mocked(decryptPullBatch).mockResolvedValue({
          decrypted: [{ id: 'inbox', type: 'tag_definition', content: '{}', operation: 'update' }],
          failures: []
        } as unknown as Awaited<ReturnType<typeof decryptPullBatch>>)

        const result = await tracker.refetch(
          [{ id: 'inbox', type: 'tag_definition' }],
          'token',
          new Uint8Array(32)
        )

        const decryptedInput = vi.mocked(decryptPullBatch).mock.calls[0][0]
        expect(decryptedInput).toHaveLength(1)
        expect(decryptedInput[0].type).toBe('tag_definition')
        expect(result.recovered).toHaveLength(1)
        expect(result.permanentFailures).toHaveLength(0)
      })
    })

    // #2302
    describe('#given the server answers with #2302 sibling entries #when refetch runs', () => {
      it('#then a purged tombstone is a recovered delete and a lost blob is neither recovered nor missing', async () => {
        vi.mocked(postToServer).mockResolvedValue({
          items: [],
          purgedTombstones: [
            purged('task-dead', 'task', { 'device-a': 2 }, 7),
            { id: 'task-clockless', type: 'task', deletedAt: 5, serverCursor: 8 },
            purged('inbox', 'project', { 'device-a': 1 }, 9)
          ],
          blobMissing: [{ id: 'task-lost', type: 'task', serverCursor: 3 }]
        })
        vi.mocked(decryptPullBatch).mockResolvedValue({ decrypted: [], failures: [] })
        const tracker = createTracker()

        const result = await tracker.refetch(
          [
            { id: 'task-dead', type: 'task' },
            { id: 'task-clockless', type: 'task' },
            { id: 'task-lost', type: 'task' },
            { id: 'inbox', type: 'tag_definition' }
          ],
          'token',
          new Uint8Array(32)
        )

        expect(result.recovered).toEqual([
          {
            id: 'task-dead',
            type: 'task',
            operation: 'delete',
            content: '',
            clock: { 'device-a': 2 },
            deletedAt: 5,
            signerDeviceId: 'device-a'
          }
        ])
        expect(result.blobMissing).toEqual([{ id: 'task-lost', type: 'task' }])
        // A refused (clockless) tombstone is not a live row the server holds, and
        // the project row of a shared id was not asked for.
        expect(result.missing).toEqual([
          { id: 'task-clockless', type: 'task' },
          { id: 'inbox', type: 'tag_definition' }
        ])
        expect(tracker.shouldRetry({ id: 'task-lost', type: 'task' })).toBe(false)
        expect(result.skipped).toEqual([])
      })

      // #2302 review: a tombstone the local guard refuses is unknown, not gone.
      it('#then a locally refused purged tombstone is skipped, neither recovered nor missing', async () => {
        vi.mocked(localTombstoneRefusal).mockReturnValueOnce('local_clockless')
        vi.mocked(postToServer).mockResolvedValue({
          items: [],
          purgedTombstones: [purged('task-dead', 'task', { 'device-a': 2 }, 7)]
        })
        vi.mocked(decryptPullBatch).mockResolvedValue({ decrypted: [], failures: [] })

        const result = await createTracker().refetch(
          [{ id: 'task-dead', type: 'task' }],
          'token',
          new Uint8Array(32)
        )

        expect(result.recovered).toEqual([])
        expect(result.missing).toEqual([])
        expect(result.skipped).toEqual([{ id: 'task-dead', type: 'task' }])
      })

      // #2408: a failure to resolve a signer key is not an answer about the
      // item: the refs take the failed-with-cooldown path and are never missing.
      it('#then a key-resolution failure is a failed refetch, never missing', async () => {
        vi.mocked(postToServer).mockResolvedValue({
          items: [],
          purgedTombstones: [purged('task-dead', 'task', { 'device-a': 2 }, 7)]
        })
        const tracker = new CorruptItemTracker(
          {
            deps: { network: { online: true }, workerBridge: undefined },
            abortController: null
          } as unknown as SyncContext,
          { quarantineItem: vi.fn() } as unknown as QuarantineManager,
          vi.fn().mockRejectedValue(new Error('No access token'))
        )
        const ref = { id: 'task-dead', type: 'task' }

        const result = await tracker.refetch([ref], 'token', new Uint8Array(32))

        expect(result.missing).toEqual([])
        expect(result.recovered).toEqual([])
        expect(result.permanentFailures).toEqual([ref])
        expect(tracker.shouldRetry(ref)).toBe(false)
      })

      // #2408: an entry no device attested is refused like an envelope refusal:
      // counted missing, never recovered, never a delete.
      it('#then a forged or unattested purged tombstone is missing, not recovered', async () => {
        const forged = purged('task-forged', 'task', { 'device-a': 2 }, 7)
        vi.mocked(postToServer).mockResolvedValue({
          items: [],
          purgedTombstones: [
            { ...forged, clock: { x: 2 ** 31 } },
            purged('task-legacy', 'task', { 'device-a': 2 }, 8, false),
            { ...purged('task-unknown', 'task', { 'device-a': 2 }, 9), signerDeviceId: 'device-x' }
          ]
        })
        vi.mocked(decryptPullBatch).mockResolvedValue({ decrypted: [], failures: [] })
        vi.mocked(localTombstoneRefusal).mockClear()
        const refs = ['task-forged', 'task-legacy', 'task-unknown'].map((id) => ({
          id,
          type: 'task'
        }))

        const result = await createTracker().refetch(refs, 'token', new Uint8Array(32))

        expect(result.recovered).toEqual([])
        expect(result.skipped).toEqual([])
        expect(result.missing).toEqual(refs)
        expect(localTombstoneRefusal).not.toHaveBeenCalled()
      })
    })
  })
})
