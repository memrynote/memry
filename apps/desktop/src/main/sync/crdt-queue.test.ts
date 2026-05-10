import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CrdtUpdateQueue } from './crdt-queue'
import { SyncServerError } from './http-client'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

const flushPromises = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('CrdtUpdateQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T09:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('buffers updates by note, flushes on the interval, and tracks outstanding work', async () => {
    const queue = new CrdtUpdateQueue()
    const push = vi.fn(async () => undefined)

    queue.start(push)
    queue.enqueue('note-a', new Uint8Array([1]))
    queue.enqueue('note-a', new Uint8Array([2]))
    queue.enqueue('note-b', new Uint8Array([3]))

    expect(queue.getPendingCount()).toBe(3)
    expect(queue.getOutstandingCount()).toBe(3)

    vi.advanceTimersByTime(1000)

    expect(push).toHaveBeenCalledWith('note-a', [new Uint8Array([1]), new Uint8Array([2])])
    expect(push).toHaveBeenCalledWith('note-b', [new Uint8Array([3])])
    expect(queue.getPendingCount()).toBe(0)
    expect(queue.getOutstandingCount()).toBe(2)

    await flushPromises()
    expect(queue.getOutstandingCount()).toBe(0)

    queue.stop()
  })

  it('pauses flushes, resumes queued work, and retries retryable push failures', async () => {
    const queue = new CrdtUpdateQueue()
    const push = vi
      .fn<(noteId: string, updates: Uint8Array[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(undefined)

    queue.start(push)
    queue.pause()
    queue.enqueue('note-a', new Uint8Array([1]))
    vi.advanceTimersByTime(1000)

    expect(push).not.toHaveBeenCalled()
    expect(queue.getPendingCount()).toBe(1)

    queue.resume()
    expect(push).toHaveBeenCalledTimes(1)
    await flushPromises()
    expect(queue.getPendingCount()).toBe(1)

    vi.advanceTimersByTime(1000)
    expect(push).toHaveBeenCalledTimes(2)
    await flushPromises()
    expect(queue.getPendingCount()).toBe(0)

    queue.stop()
  })

  it('drops non-retryable client failures and flushes immediately at the max batch size', async () => {
    const queue = new CrdtUpdateQueue()
    const push = vi.fn(async () => {
      throw new SyncServerError('bad update', 400)
    })

    queue.start(push)
    for (let i = 0; i < 50; i++) {
      queue.enqueue('note-a', new Uint8Array([i]))
    }

    expect(push).toHaveBeenCalledTimes(1)
    await flushPromises()
    expect(queue.getPendingCount()).toBe(0)
    expect(queue.getOutstandingCount()).toBe(0)

    queue.stop()
  })

  it('drops updates flushed before a push function is registered', async () => {
    const queue = new CrdtUpdateQueue()

    queue.enqueue('note-a', new Uint8Array([1]))
    queue.stop()

    expect(queue.getPendingCount()).toBe(0)
  })
})
