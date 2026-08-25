import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { DownloadQueue, DownloadQueueClearedError, DownloadPacer } from './download-queue'
import { NetworkError, RateLimitError } from './http-client'
import { DeadLetterError } from '@memry/sync-client/retry'
import type { NetworkMonitor } from './network'
import type { DownloadResult } from './attachments'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

function makeResult(attachmentId: string): DownloadResult {
  return {
    filePath: `/tmp/${attachmentId}`,
    manifest: { id: attachmentId } as DownloadResult['manifest']
  }
}

interface ManualDownload {
  fn: ReturnType<typeof vi.fn>
  calls: string[]
  settle: (attachmentId: string) => void
  failWith: (attachmentId: string, err: Error) => void
}

/** A DownloadFn whose calls hang until explicitly settled, recording order. */
function makeManualDownload(): ManualDownload {
  const calls: string[] = []
  const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>()
  const fn = vi.fn(
    (
      _id: string,
      _targetPath: string,
      opts?: { pace?: () => Promise<void>; isOnline?: () => boolean }
    ) => {
      void opts?.pace?.()
      calls.push(_id)
      return new Promise<DownloadResult>((resolve, reject) => {
        pending.set(_id, { resolve: () => resolve(makeResult(_id)), reject })
      })
    }
  )
  return {
    fn,
    calls,
    settle: (attachmentId) => {
      pending.get(attachmentId)?.resolve()
      pending.delete(attachmentId)
    },
    failWith: (attachmentId, err) => {
      pending.get(attachmentId)?.reject(err)
      pending.delete(attachmentId)
    }
  }
}

function createMockNetworkMonitor(initialOnline = true): NetworkMonitor & EventEmitter {
  const emitter = new EventEmitter()
  let _online = initialOnline
  Object.defineProperty(emitter, 'online', { get: () => _online, configurable: true })
  const setOnline = (v: boolean): void => {
    _online = v
    emitter.emit('status-changed', { online: v })
  }
  ;(emitter as unknown as { setOnline: typeof setOnline }).setOnline = setOnline
  return emitter as unknown as NetworkMonitor & EventEmitter
}

describe('DownloadQueue', () => {
  beforeEach(() => {})

  afterEach(() => {
    vi.useRealTimers()
  })

  it('caps concurrent downloads to 3 under a burst', async () => {
    let peakConcurrent = 0
    let currentConcurrent = 0
    const fn = vi.fn(async (attachmentId: string) => {
      currentConcurrent++
      peakConcurrent = Math.max(peakConcurrent, currentConcurrent)
      await new Promise((r) => setTimeout(r, 20))
      currentConcurrent--
      return makeResult(attachmentId)
    })

    const q = new DownloadQueue(fn)
    const promises = Array.from({ length: 12 }, (_, i) =>
      q.enqueue({ ownerId: `n${i}`, attachmentId: `a${i}`, targetPath: `/p/${i}` })
    )
    await Promise.all(promises)

    expect(fn).toHaveBeenCalledTimes(12)
    expect(peakConcurrent).toBeLessThanOrEqual(3)
    expect(peakConcurrent).toBeGreaterThanOrEqual(2)
  })

  it('passes pace() to every transfer so requests spend pacing tokens', async () => {
    const paced: number[] = []
    const fn = vi.fn(async (_id: string, _p: string, opts?: { pace?: () => Promise<void> }) => {
      await opts?.pace?.()
      paced.push(1)
      return makeResult(_id)
    })
    const q = new DownloadQueue(fn)
    await Promise.all([
      q.enqueue({ ownerId: 'n1', attachmentId: 'a1', targetPath: '/p1' }),
      q.enqueue({ ownerId: 'n2', attachmentId: 'a2', targetPath: '/p2' })
    ])
    expect(paced).toHaveLength(2)
  })

  it('pauses everything on 429 honouring Retry-After, then resumes', async () => {
    vi.useFakeTimers()
    let calls = 0
    let rateLimitThrownAt = 0
    const fn = vi.fn(async (attachmentId: string) => {
      calls++
      if (calls === 1) {
        rateLimitThrownAt = Date.now()
        throw new RateLimitError(30)
      }
      return makeResult(attachmentId)
    })
    const q = new DownloadQueue(fn)

    const p1 = q.enqueue({ ownerId: 'n1', attachmentId: 'a1', targetPath: '/p1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    // The 429 has landed by now (microtasks flushed above); everything enqueued
    // from here on parks until the Retry-After window closes.
    const p2 = q.enqueue({ ownerId: 'n2', attachmentId: 'a2', targetPath: '/p2' })

    // Nothing runs inside the Retry-After window (30s here), even though slots
    // are free — the whole queue is parked.
    await vi.advanceTimersByTimeAsync(29_999)
    expect(calls).toBe(1)

    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(0)
    // Three calls total: the parked item's retry plus the second item. Both
    // waited out the Retry-After window.
    expect(calls).toBe(3)
    // Elapsed honours the header: retried no earlier than 30s after the 429.
    expect(Date.now() - rateLimitThrownAt).toBeGreaterThanOrEqual(30_000)

    await expect(p1).resolves.toMatchObject({ manifest: { id: 'a1' } })
    await expect(p2).resolves.toMatchObject({ manifest: { id: 'a2' } })
  })

  it('backs off per item on network errors: 1s doubling to the 60s ceiling', async () => {
    vi.useFakeTimers()
    let calls = 0
    const fn = vi.fn(async (attachmentId: string) => {
      calls++
      if (calls <= 8) throw new NetworkError('offline')
      return makeResult(attachmentId)
    })
    const q = new DownloadQueue(fn)

    const pending = q.enqueue({ ownerId: 'n1', attachmentId: 'a1', targetPath: '/p1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)

    const expectedDelaysMs = [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]
    for (let i = 0; i < expectedDelaysMs.length; i++) {
      await vi.advanceTimersByTimeAsync(expectedDelaysMs[i] - 1)
      expect(calls).toBe(i + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toBe(i + 2)
    }

    await expect(pending).resolves.toMatchObject({ manifest: { id: 'a1' } })
  })

  it('requeues an exhausted-withRetry item instead of dropping it', async () => {
    // #given — downloadFn mirrors what the service actually surfaces: a
    // DeadLetterError wrapping the last transport error
    vi.useFakeTimers()
    let calls = 0
    const fn = vi.fn(async (attachmentId: string) => {
      calls++
      if (calls === 1) throw new DeadLetterError(new NetworkError('offline'), 6)
      return makeResult(attachmentId)
    })
    const q = new DownloadQueue(fn)

    // #when
    const pending = q.enqueue({ ownerId: 'n1', attachmentId: 'a1', targetPath: '/p1' })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)

    // #then — the item ran twice, not rejected to its caller
    expect(calls).toBe(2)
    await expect(pending).resolves.toMatchObject({ manifest: { id: 'a1' } })
  })

  it('rejects non-transient errors straight to the caller', async () => {
    const fn = vi.fn(async () => {
      throw new Error('Chunk integrity failure')
    })
    const q = new DownloadQueue(fn)
    await expect(
      q.enqueue({ ownerId: 'n1', attachmentId: 'a1', targetPath: '/p1' })
    ).rejects.toThrow('Chunk integrity failure')
    expect(q.pending).toBe(0)
  })

  describe('priority ordering', () => {
    it('runs interactive ahead of queued background work', async () => {
      const manual = makeManualDownload()
      const q = new DownloadQueue(
        manual.fn as unknown as ConstructorParameters<typeof DownloadQueue>[0]
      )

      // Fill the 3 slots.
      const slots = [
        q.enqueue({ ownerId: 's0', attachmentId: 'slot-1', targetPath: '/s1' }),
        q.enqueue({ ownerId: 's1', attachmentId: 'slot-2', targetPath: '/s2' }),
        q.enqueue({ ownerId: 's2', attachmentId: 'slot-3', targetPath: '/s3' })
      ]
      await waitFor(() => manual.calls.length === 3)
      expect(manual.calls).toEqual(['slot-1', 'slot-2', 'slot-3'])

      // Two eager items waiting, then an interactive jump-ahead.
      void q.enqueue({
        ownerId: 'b1',
        attachmentId: 'bulk-old',
        targetPath: '/b1',
        source: 'eager'
      })
      void q.enqueue({
        ownerId: 'b2',
        attachmentId: 'bulk-new',
        targetPath: '/b2',
        source: 'eager'
      })
      const interactive = q.enqueue({
        ownerId: 'u1',
        attachmentId: 'user-file',
        targetPath: '/u1',
        source: 'interactive'
      })

      manual.settle('slot-1')
      await waitFor(() => manual.calls.length === 4)
      expect(manual.calls[3]).toBe('user-file')

      manual.settle('slot-2')
      manual.settle('slot-3')
      manual.settle('user-file')
      manual.settle('bulk-old')
      manual.settle('bulk-new')
      await Promise.all(slots)
      await expect(interactive).resolves.toBeTruthy()
    })

    it('orders background work small-first, then recently-used, then FIFO', async () => {
      const manual = makeManualDownload()
      const q = new DownloadQueue(
        manual.fn as unknown as ConstructorParameters<typeof DownloadQueue>[0]
      )

      const slots = [
        q.enqueue({ ownerId: 's0', attachmentId: 'slot-1', targetPath: '/s1' }),
        q.enqueue({ ownerId: 's1', attachmentId: 'slot-2', targetPath: '/s2' }),
        q.enqueue({ ownerId: 's2', attachmentId: 'slot-3', targetPath: '/s3' })
      ]
      await waitFor(() => manual.calls.length === 3)

      // Deliberately enqueued worst-first: large+cold, unknown-size, small+cold,
      // small+warm(recent), small+warm(older).
      void q.enqueue({
        ownerId: 'o1',
        attachmentId: 'large-cold',
        targetPath: '/l',
        source: 'eager',
        sizeHint: 50 * 1024 * 1024,
        recencyHint: 1_000
      })
      void q.enqueue({
        ownerId: 'o2',
        attachmentId: 'unknown-size',
        targetPath: '/u',
        source: 'redrive'
      })
      void q.enqueue({
        ownerId: 'o3',
        attachmentId: 'small-cold',
        targetPath: '/sc',
        source: 'eager',
        sizeHint: 1024,
        recencyHint: 500
      })
      void q.enqueue({
        ownerId: 'o4',
        attachmentId: 'small-recent',
        targetPath: '/sr',
        source: 'eager',
        sizeHint: 1024,
        recencyHint: 9_000
      })
      void q.enqueue({
        ownerId: 'o5',
        attachmentId: 'small-warm',
        targetPath: '/sw',
        source: 'eager',
        sizeHint: 1024,
        recencyHint: 5_000
      })

      // Free exactly one slot at a time; each freed slot must pick the best
      // remaining item by the hybrid order.
      const expectedOrder = [
        'small-recent',
        'small-warm',
        'small-cold',
        'unknown-size',
        'large-cold'
      ]
      manual.settle('slot-1')
      let next = 4
      for (const expected of expectedOrder) {
        await waitFor(() => manual.calls.length === next)
        expect(manual.calls[next - 1]).toBe(expected)
        manual.settle(expected)
        next++
      }

      manual.settle('slot-2')
      manual.settle('slot-3')
      await Promise.all(slots)
    })
  })

  it('dedupes concurrent requests for the same owner+attachment', async () => {
    const manual = makeManualDownload()
    const q = new DownloadQueue(
      manual.fn as unknown as ConstructorParameters<typeof DownloadQueue>[0]
    )

    const first = q.enqueue({ ownerId: 'note-1', attachmentId: 'att-1', targetPath: '/dir' })
    const second = q.enqueue({ ownerId: 'note-1', attachmentId: 'att-1', targetPath: '/dir' })

    await waitFor(() => manual.calls.length === 1)
    manual.settle('att-1')

    const [r1, r2] = await Promise.all([first, second])
    expect(manual.calls.filter((id) => id === 'att-1')).toHaveLength(1)
    expect(r1.filePath).toBe(r2.filePath)
  })

  it('an interactive re-request upgrades the queued item and rides it', async () => {
    const manual = makeManualDownload()
    const q = new DownloadQueue(
      manual.fn as unknown as ConstructorParameters<typeof DownloadQueue>[0]
    )

    const bulk = q.enqueue({ ownerId: 'note-1', attachmentId: 'att-1', targetPath: '/dir' })
    const urgent = q.enqueue({
      ownerId: 'note-1',
      attachmentId: 'att-1',
      targetPath: '/dir',
      source: 'interactive'
    })

    await waitFor(() => manual.calls.length === 1)
    manual.settle('att-1')

    await expect(bulk).resolves.toBeTruthy()
    await expect(urgent).resolves.toBeTruthy()
    expect(manual.calls).toHaveLength(1)
  })

  describe('clear and dispose', () => {
    it('clear() rejects pending items with DownloadQueueClearedError', async () => {
      const manual = makeManualDownload()
      const q = new DownloadQueue(
        manual.fn as unknown as ConstructorParameters<typeof DownloadQueue>[0]
      )

      // Fill all three slots, so the fourth item is genuinely parked.
      const running = [
        q.enqueue({ ownerId: 'n1', attachmentId: 'slot-1', targetPath: '/s1' }),
        q.enqueue({ ownerId: 'n2', attachmentId: 'slot-2', targetPath: '/s2' }),
        q.enqueue({ ownerId: 'n3', attachmentId: 'slot-3', targetPath: '/s3' })
      ]
      await waitFor(() => manual.calls.length === 3)
      const parked = q.enqueue({ ownerId: 'n4', attachmentId: 'parked', targetPath: '/p' })
      await waitFor(() => q.pending === 1)

      q.clear()

      await expect(parked).rejects.toBeInstanceOf(DownloadQueueClearedError)
      expect(q.pending).toBe(0)

      manual.settle('slot-1')
      manual.settle('slot-2')
      manual.settle('slot-3')
      // Running transfers are untouched by clear().
      await Promise.all(running)
    })

    it('a mid-flight failure after dispose settles as cleared, never re-queued', async () => {
      vi.useFakeTimers()
      const manual = makeManualDownload()
      const monitor = createMockNetworkMonitor(true)
      const q = new DownloadQueue(
        manual.fn as unknown as ConstructorParameters<typeof DownloadQueue>[0],
        monitor
      )

      const pending = q.enqueue({ ownerId: 'n1', attachmentId: 'slot-1', targetPath: '/s' })
      await vi.advanceTimersByTimeAsync(0)
      expect(manual.calls).toEqual(['slot-1'])

      // Vault switch: runtime teardown disposes the queue, THEN the in-flight
      // transfer fails transiently.
      q.dispose()
      manual.failWith('slot-1', new NetworkError('offline'))
      await expect(pending).rejects.toBeInstanceOf(DownloadQueueClearedError)
      expect(q.pending).toBe(0)

      // And the dead queue stays deaf to its (also dead) monitor.
      const before = manual.calls.length
      ;(monitor as unknown as { setOnline: (v: boolean) => void }).setOnline(false)
      expect(manual.calls.length).toBe(before)
    })

    it('dispose() detaches from the network monitor', async () => {
      const monitor = createMockNetworkMonitor(true)
      const otherListener = vi.fn()
      monitor.on('status-changed', otherListener)

      const fn = vi.fn(async (id: string) => makeResult(id))
      const q = new DownloadQueue(fn, monitor)
      q.dispose()

      expect(monitor.listenerCount('status-changed')).toBe(1)
      ;(monitor as unknown as { setOnline: (v: boolean) => void }).setOnline(false)
      expect(otherListener).toHaveBeenCalledWith({ online: false })
    })
  })

  describe('network awareness', () => {
    it('drains the queue and resets escalated backoff on reconnect', async () => {
      vi.useFakeTimers()
      let calls = 0
      const fn = vi.fn(async (attachmentId: string) => {
        calls++
        if (calls <= 12) throw new NetworkError('offline')
        return makeResult(attachmentId)
      })
      const monitor = createMockNetworkMonitor(false)
      const q = new DownloadQueue(fn, monitor)

      const pending = q.enqueue({ ownerId: 'n1', attachmentId: 'a1', targetPath: '/p1' })
      await vi.advanceTimersByTimeAsync(0)
      for (const delay of [1000, 2000, 4000, 8000, 16_000, 32_000]) {
        await vi.advanceTimersByTimeAsync(delay)
      }
      expect(calls).toBe(7)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(calls).toBe(7)

      // Reconnect halfway through the 60s ceiling wait.
      ;(monitor as unknown as { setOnline: (v: boolean) => void }).setOnline(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBe(8)

      // Escalation reset: next retry is 1s again.
      await vi.advanceTimersByTimeAsync(999)
      expect(calls).toBe(8)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toBe(9)

      await vi.advanceTimersByTimeAsync(120_000)
      await expect(pending).resolves.toMatchObject({ manifest: { id: 'a1' } })
    })
  })
})

describe('DownloadPacer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('admits up to maxRequests instantly and delays the rest until the window slides', async () => {
    vi.useFakeTimers()
    const pacer = new DownloadPacer(3, 50)

    await pacer.acquire()
    await pacer.acquire()
    await pacer.acquire()

    let fourthDone = false
    void pacer.acquire().then(() => {
      fourthDone = true
    })

    await vi.advanceTimersByTimeAsync(49)
    expect(fourthDone).toBe(false)

    // At t=50 the three original stamps leave the window and the fourth goes.
    await vi.advanceTimersByTimeAsync(1)
    expect(fourthDone).toBe(true)

    // The window is a trailing one: at t=50 the three original stamps leave and
    // three fresh admissions fit before the window closes again.
    await vi.advanceTimersByTimeAsync(1)
    expect(fourthDone).toBe(true)

    // Three more acquires ride along inside the same (now open) window; the
    // rest park until it slides again at t=100.
    let admitted = 0
    for (let i = 0; i < 4; i++) {
      void pacer.acquire().then(() => {
        admitted++
      })
    }
    await vi.advanceTimersByTimeAsync(49)
    expect(admitted).toBe(3)

    await vi.advanceTimersByTimeAsync(1)
    expect(admitted).toBe(4)
  })
})

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 1))
  }
}
