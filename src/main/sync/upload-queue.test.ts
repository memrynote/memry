import { describe, it, expect, vi, beforeEach } from 'vitest'
import { UploadQueue, type UploadFn } from './upload-queue'
import { RateLimitError } from './http-client'

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

    expect(mockFn).toHaveBeenCalledWith('note-1', '/path/1', onProgress)
  })
})
