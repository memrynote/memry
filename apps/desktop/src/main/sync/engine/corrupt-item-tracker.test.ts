import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CorruptItemTracker } from './corrupt-item-tracker'
import { CORRUPT_ITEM_COOLDOWN_MS, MAX_CORRUPT_ITEMS } from './sync-context'
import type { SyncContext } from './sync-context'
import type { QuarantineManager } from './quarantine-manager'
import { postToServer } from '../http-client'
import { decryptPullBatch } from '../sync-crypto-batch'

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

  const resolveDeviceKey = vi.fn().mockResolvedValue(new Uint8Array(32))

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

        expect(result).toEqual({ recovered: [], permanentFailures: [] })
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
  })
})
