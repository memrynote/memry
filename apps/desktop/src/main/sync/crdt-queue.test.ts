import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
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

  it('re-buffers the flushed batch when the push fails with a 401', async () => {
    const queue = new CrdtUpdateQueue()
    const push = vi.fn(async () => {
      throw new SyncServerError('Token expired: "exp" claim', 401)
    })

    queue.start(push)
    queue.enqueue('note-a', new Uint8Array([1]))
    queue.enqueue('note-a', new Uint8Array([2]))
    vi.advanceTimersByTime(1000)

    expect(push).toHaveBeenCalledTimes(1)
    await flushPromises()
    expect(queue.getPendingCount()).toBe(2)

    queue.pause()
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

  it('coalesces a paused buffer instead of growing it per update, losing nothing', async () => {
    const queue = new CrdtUpdateQueue()
    const pushed: Uint8Array[] = []
    const push = vi.fn(async (_noteId: string, updates: Uint8Array[]) => {
      pushed.push(...updates)
    })

    // Real Yjs updates, one per transaction, exactly what the provider forwards
    // while the queue is paused. ~1KB each so the total crosses the merged-run
    // size bound several times over and the coalesced buffer holds more than a
    // single merged entry.
    const source = new Y.Doc()
    const rawUpdates: Uint8Array[] = []
    source.on('update', (update: Uint8Array) => rawUpdates.push(update))
    const text = source.getText('body')
    for (let i = 0; i < 1000; i++) {
      text.insert(text.length, `${String(i).padStart(4, '0')}${'x'.repeat(1020)}`)
    }
    expect(rawUpdates).toHaveLength(1000)

    queue.start(push)
    queue.pause()
    for (const update of rawUpdates) {
      queue.enqueue('note-a', update)
    }

    // Bounded: a handful of merged runs, not one buffer entry per edit.
    expect(queue.getPendingCount()).toBeLessThanOrEqual(50)
    expect(queue.getPendingCount()).toBeGreaterThan(1)
    expect(push).not.toHaveBeenCalled()

    queue.resume()
    for (let i = 0; i < 20; i++) {
      await flushPromises()
      vi.advanceTimersByTime(1000)
    }
    await flushPromises()
    expect(queue.getPendingCount()).toBe(0)

    // No flush carries a payload the server would reject (~900KB base64).
    for (const [, updates] of push.mock.calls) {
      const bytes = updates.reduce((total, update) => total + update.byteLength, 0)
      expect(bytes).toBeLessThanOrEqual(768 * 1024)
    }

    // Every character the user typed while paused still reaches the server.
    const replica = new Y.Doc()
    for (const update of pushed) {
      Y.applyUpdate(replica, update)
    }
    expect(replica.getText('body').toString()).toBe(text.toString())

    queue.stop()
  })

  it('hands still-buffered notes to the durable store when stopped while paused', () => {
    const persistUnflushed = vi.fn()
    const queue = new CrdtUpdateQueue({ persistUnflushed })

    queue.start(vi.fn(async () => undefined))
    queue.pause()
    queue.enqueue('note-a', new Uint8Array([1]))
    queue.enqueue('note-b', new Uint8Array([2]))

    queue.stop()

    expect(persistUnflushed).toHaveBeenCalledWith(['note-a', 'note-b'])
  })

  it('does not persist anything when the shutdown flush drains the buffers', async () => {
    const persistUnflushed = vi.fn()
    const queue = new CrdtUpdateQueue({ persistUnflushed })

    queue.start(vi.fn(async () => undefined))
    queue.enqueue('note-a', new Uint8Array([1]))
    await flushPromises()
    vi.advanceTimersByTime(1000)
    await flushPromises()

    queue.stop()

    expect(persistUnflushed).not.toHaveBeenCalled()
  })
})
