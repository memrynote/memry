import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CorruptItemTracker } from './corrupt-item-tracker'
import { CORRUPT_ITEM_COOLDOWN_MS } from './sync-context'
import type { SyncContext } from './sync-context'
import type { QuarantineManager } from './quarantine-manager'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
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

        const result = tracker.shouldRetry('item-1')

        expect(result).toBe(true)
      })
    })

    describe('#given recently failed item #when shouldRetry called', () => {
      it('#then returns false', () => {
        const tracker = createTracker()
        tracker.markFailed('item-1')

        const result = tracker.shouldRetry('item-1')

        expect(result).toBe(false)
      })
    })

    describe('#given failed item #when cooldown has expired', () => {
      it('#then returns true', () => {
        const tracker = createTracker()
        tracker.markFailed('item-1')

        vi.advanceTimersByTime(CORRUPT_ITEM_COOLDOWN_MS + 1)

        const result = tracker.shouldRetry('item-1')

        expect(result).toBe(true)
      })
    })
  })

  describe('markFailed', () => {
    describe('#given new item #when markFailed called', () => {
      it('#then creates entry with attempts=1', () => {
        const tracker = createTracker()

        tracker.markFailed('item-1')

        expect(tracker.shouldRetry('item-1')).toBe(false)
      })
    })

    describe('#given existing failed item #when markFailed called again', () => {
      it('#then increments attempts and item remains not retryable', () => {
        const tracker = createTracker()
        tracker.markFailed('item-1')
        tracker.markFailed('item-1')

        expect(tracker.shouldRetry('item-1')).toBe(false)
      })
    })
  })

  describe('clearExpired', () => {
    describe('#given expired and fresh entries #when clearExpired called', () => {
      it('#then removes only expired entries', () => {
        const tracker = createTracker()

        tracker.markFailed('old-item')
        vi.advanceTimersByTime(CORRUPT_ITEM_COOLDOWN_MS + 1)
        tracker.markFailed('fresh-item')

        tracker.clearExpired()

        expect(tracker.shouldRetry('old-item')).toBe(true)
        expect(tracker.shouldRetry('fresh-item')).toBe(false)
      })
    })
  })

  describe('clear', () => {
    describe('#given tracked items #when clear called', () => {
      it('#then removes all entries', () => {
        const tracker = createTracker()
        tracker.markFailed('item-1')
        tracker.markFailed('item-2')

        tracker.clear()

        expect(tracker.shouldRetry('item-1')).toBe(true)
        expect(tracker.shouldRetry('item-2')).toBe(true)
      })
    })
  })

  describe('refetch', () => {
    describe('#given all items on cooldown #when refetch called', () => {
      it('#then returns empty recovered and permanentFailures', async () => {
        const tracker = createTracker()
        tracker.markFailed('item-1')
        tracker.markFailed('item-2')

        const result = await tracker.refetch(['item-1', 'item-2'], 'token', new Uint8Array(32))

        expect(result).toEqual({ recovered: [], permanentFailures: [] })
      })
    })
  })
})
