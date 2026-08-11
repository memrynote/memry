import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { UploadQueue, type UploadFn } from './upload-queue'
import { NetworkError, RateLimitError } from './http-client'
import type { NetworkMonitor } from './network'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

function makeUploadFn(delayMs = 10): UploadFn {
  return vi.fn(async (noteId: string) => {
    await new Promise((r) => setTimeout(r, delayMs))
    return { attachmentId: `att-${noteId}`, sessionId: `sess-${noteId}`, manifest: {} as never }
  })
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

describe('UploadQueue', () => {
  let uploadFn: UploadFn
  let queue: UploadQueue

  beforeEach(() => {
    uploadFn = makeUploadFn(10)
    queue = new UploadQueue(uploadFn)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('caps concurrent uploads to 3', async () => {
    let peakConcurrent = 0
    let currentConcurrent = 0

    const slowFn: UploadFn = async (noteId) => {
      currentConcurrent++
      peakConcurrent = Math.max(peakConcurrent, currentConcurrent)
      await new Promise((r) => setTimeout(r, 50))
      currentConcurrent--
      return { attachmentId: `att-${noteId}`, sessionId: `sess-${noteId}`, manifest: {} as never }
    }

    const q = new UploadQueue(slowFn)
    const promises = Array.from({ length: 6 }, (_, i) => q.enqueue(`note-${i}`, `/path/${i}`))

    await Promise.all(promises)
    expect(peakConcurrent).toBeLessThanOrEqual(3)
    expect(peakConcurrent).toBeGreaterThanOrEqual(2)
  })

  it('pauses all pending on 429 then resumes', async () => {
    let callCount = 0

    const rateLimitFn: UploadFn = async (noteId) => {
      callCount++
      if (callCount === 2) {
        throw new RateLimitError(0.05)
      }
      await new Promise((r) => setTimeout(r, 5))
      return { attachmentId: `att-${noteId}`, sessionId: `sess-${noteId}`, manifest: {} as never }
    }

    const q = new UploadQueue(rateLimitFn)
    const results = await Promise.all([
      q.enqueue('n1', '/p1'),
      q.enqueue('n2', '/p2'),
      q.enqueue('n3', '/p3')
    ])

    expect(results).toHaveLength(3)
    results.forEach((r) => expect(r.attachmentId).toBeTruthy())
  })

  it('resolves all enqueued items eventually', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => queue.enqueue(`note-${i}`, `/path/${i}`))
    )

    expect(results).toHaveLength(10)
    expect(uploadFn).toHaveBeenCalledTimes(10)
    results.forEach((r, i) => {
      expect(r.attachmentId).toBe(`att-note-${i}`)
    })
  })

  it('isolates errors — one failure does not block others', async () => {
    let callIdx = 0
    const flakyFn: UploadFn = async (noteId) => {
      const idx = callIdx++
      await new Promise((r) => setTimeout(r, 5))
      if (idx === 1) throw new Error('boom')
      return { attachmentId: `att-${noteId}`, sessionId: `sess-${noteId}`, manifest: {} as never }
    }

    const q = new UploadQueue(flakyFn)

    const results = await Promise.allSettled([
      q.enqueue('n0', '/p0'),
      q.enqueue('n1', '/p1'),
      q.enqueue('n2', '/p2'),
      q.enqueue('n3', '/p3')
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    expect(fulfilled.length).toBe(3)
    expect(rejected.length).toBe(1)
  })

  it('clear() rejects all pending promises', async () => {
    const neverResolve: UploadFn = () => new Promise(() => {})

    const q = new UploadQueue(neverResolve)

    const promises = Array.from({ length: 5 }, (_, i) => q.enqueue(`n${i + 1}`, `/p${i + 1}`))

    await new Promise((r) => setTimeout(r, 10))
    q.clear()

    const results = await Promise.allSettled(promises.slice(3))
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(rejected.length).toBeGreaterThanOrEqual(1)
    rejected.forEach((r) => {
      if (r.status === 'rejected') {
        expect(r.reason.message).toBe('Upload queue cleared')
      }
    })
  })

  it('passes onProgress callback through to uploadFn', async () => {
    const mockFn = makeUploadFn(5)
    const q = new UploadQueue(mockFn)
    const onProgress = vi.fn()

    await q.enqueue('note-1', '/path/1', onProgress)

    expect(mockFn).toHaveBeenCalledWith(
      'note-1',
      '/path/1',
      onProgress,
      expect.objectContaining({})
    )
  })

  describe('network awareness', () => {
    it('re-queues on NetworkError and resolves on retry', async () => {
      // #given
      let callCount = 0
      const flakyNetFn: UploadFn = vi.fn(async (noteId) => {
        callCount++
        if (callCount === 1) throw new NetworkError('offline')
        await new Promise((r) => setTimeout(r, 5))
        return { attachmentId: `att-${noteId}`, sessionId: `sess-${noteId}`, manifest: {} as never }
      })

      const monitor = createMockNetworkMonitor(true)
      const q = new UploadQueue(flakyNetFn, monitor)

      // #when
      const result = await q.enqueue('n1', '/p1')

      // #then
      expect(result.attachmentId).toBe('att-n1')
      expect(callCount).toBe(2)
    })

    it('drains queue when network restored event fires', async () => {
      // #given
      const monitor = createMockNetworkMonitor(false)
      const fn = makeUploadFn(5)
      const q = new UploadQueue(fn, monitor)

      q.enqueue('n1', '/p1')
      await new Promise((r) => setTimeout(r, 20))

      // #when — simulate network restored
      ;(monitor as unknown as { setOnline: (v: boolean) => void }).setOnline(true)
      await new Promise((r) => setTimeout(r, 50))

      // #then
      expect(fn).toHaveBeenCalled()
    })

    it('does not trigger drain on offline event', async () => {
      // #given
      const monitor = createMockNetworkMonitor(true)
      const fn = makeUploadFn(5)
      const q = new UploadQueue(fn, monitor)

      // drain spy — after construction, drain has been idle
      const drainSpy = vi.spyOn(q as unknown as { drain: () => void }, 'drain')

      // #when — fire offline event
      ;(monitor as unknown as { setOnline: (v: boolean) => void }).setOnline(false)
      await new Promise((r) => setTimeout(r, 20))

      // #then — drain should not have been called by the offline event
      // (it may have been called during constructor setup, but not from the event)
      const callsAfterEvent = drainSpy.mock.calls.length
      ;(monitor as unknown as { setOnline: (v: boolean) => void }).setOnline(false)
      await new Promise((r) => setTimeout(r, 20))
      expect(drainSpy.mock.calls.length).toBe(callsAfterEvent)
    })

    it('backs off exponentially between NetworkError retries and caps the delay at 60s', async () => {
      // #given — an upload that is unreachable for its first 8 attempts. The
      // bound matters: without backoff the re-queue loop is pure microtasks and
      // an unbounded failure would starve the timers instead of failing.
      vi.useFakeTimers()
      let calls = 0
      const fn: UploadFn = vi.fn(async (noteId: string) => {
        calls++
        if (calls <= 8) throw new NetworkError('offline')
        return { attachmentId: `att-${noteId}`, sessionId: `sess-${noteId}`, manifest: {} as never }
      })
      const q = new UploadQueue(fn)

      // #when
      const pending = q.enqueue('n1', '/p1')
      await vi.advanceTimersByTimeAsync(0)

      // #then — one attempt, then each retry waits its exact backoff
      expect(calls).toBe(1)

      // 1s, 2s, 4s, 8s, 16s, 32s, then the 60s ceiling (not 64s, not 128s)
      const expectedDelaysMs = [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]
      for (let i = 0; i < expectedDelaysMs.length; i++) {
        await vi.advanceTimersByTimeAsync(expectedDelaysMs[i] - 1)
        expect(calls).toBe(i + 1)
        await vi.advanceTimersByTimeAsync(1)
        expect(calls).toBe(i + 2)
      }

      // the caller's promise settles — the item is never dropped
      await expect(pending).resolves.toMatchObject({ attachmentId: 'att-n1' })
    })

    it('resumes immediately on reconnect and resets the escalated backoff', async () => {
      // #given — offline, escalated all the way to the 60s ceiling
      vi.useFakeTimers()
      let calls = 0
      const fn: UploadFn = vi.fn(async (noteId: string) => {
        calls++
        if (calls <= 12) throw new NetworkError('offline')
        return { attachmentId: `att-${noteId}`, sessionId: `sess-${noteId}`, manifest: {} as never }
      })
      const monitor = createMockNetworkMonitor(false)
      const q = new UploadQueue(fn, monitor)

      const pending = q.enqueue('n1', '/p1')
      await vi.advanceTimersByTimeAsync(0)
      for (const delay of [1000, 2000, 4000, 8000, 16_000, 32_000]) {
        await vi.advanceTimersByTimeAsync(delay)
      }
      expect(calls).toBe(7)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(calls).toBe(7)

      // #when — network comes back halfway through the 60s ceiling wait
      ;(monitor as unknown as { setOnline: (v: boolean) => void }).setOnline(true)
      await vi.advanceTimersByTimeAsync(0)

      // #then — retried at once, not after the remaining 30s
      expect(calls).toBe(8)

      // and the escalation is reset: the next retry is 1s again, not 60s
      await vi.advanceTimersByTimeAsync(999)
      expect(calls).toBe(8)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toBe(9)

      await vi.advanceTimersByTimeAsync(120_000)
      await expect(pending).resolves.toMatchObject({ attachmentId: 'att-n1' })
    })

    it('a successful transfer clears the network backoff holding the rest of the queue', async () => {
      // #given — n1 is unreachable, n2 succeeds 500ms in
      vi.useFakeTimers()
      let n1Calls = 0
      const fn: UploadFn = vi.fn(async (noteId: string) => {
        if (noteId === 'n1') {
          n1Calls++
          if (n1Calls <= 5) throw new NetworkError('offline')
        } else {
          await new Promise((r) => setTimeout(r, 500))
        }
        return { attachmentId: `att-${noteId}`, sessionId: `sess-${noteId}`, manifest: {} as never }
      })
      const q = new UploadQueue(fn)

      const p1 = q.enqueue('n1', '/p1')
      const p2 = q.enqueue('n2', '/p2')
      await vi.advanceTimersByTimeAsync(0)
      expect(n1Calls).toBe(1)

      // #when — n2 completes at t=500, inside n1's 1000ms network backoff
      await vi.advanceTimersByTimeAsync(500)
      await vi.advanceTimersByTimeAsync(0)

      // #then — the proven-good network releases the queue straight away
      await expect(p2).resolves.toMatchObject({ attachmentId: 'att-n2' })
      expect(n1Calls).toBe(2)

      await vi.advanceTimersByTimeAsync(300_000)
      await expect(p1).resolves.toMatchObject({ attachmentId: 'att-n1' })
    })

    it('dispose() stops listening without nuking other listeners', async () => {
      // #given
      const monitor = createMockNetworkMonitor(true)
      const fn = makeUploadFn(5)
      const q = new UploadQueue(fn, monitor)

      const otherListener = vi.fn()
      monitor.on('status-changed', otherListener)

      // #when
      q.dispose()

      // #then — queue's listener removed, other listener survives
      expect(q.pending).toBe(0)
      expect(monitor.listenerCount('status-changed')).toBe(1)
      ;(monitor as unknown as { setOnline: (v: boolean) => void }).setOnline(false)
      expect(otherListener).toHaveBeenCalledWith({ online: false })
    })
  })
})
