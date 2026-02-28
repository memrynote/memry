import { describe, it, expect, vi, beforeEach } from 'vitest'
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
