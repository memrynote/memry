import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

import { CrdtSnapshotScheduler } from './crdt-snapshot-scheduler'

describe('CrdtSnapshotScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces a burst of requests into one push after the quiet period', async () => {
    const push = vi.fn().mockResolvedValue(true)
    const scheduler = new CrdtSnapshotScheduler(push, { quietMs: 30_000, maxWaitMs: 120_000 })

    for (let i = 0; i < 20; i++) {
      scheduler.request('note-1')
      await vi.advanceTimersByTimeAsync(1000)
    }

    expect(push).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith('note-1')
  })

  it('still pushes during an uninterrupted run once the max wait elapses', async () => {
    const push = vi.fn().mockResolvedValue(true)
    const scheduler = new CrdtSnapshotScheduler(push, { quietMs: 30_000, maxWaitMs: 120_000 })

    // 200 s of typing at one batch per second never goes quiet, so only the
    // max-wait ceiling can release a snapshot.
    for (let i = 0; i < 200; i++) {
      scheduler.request('note-1')
      await vi.advanceTimersByTimeAsync(1000)
    }

    expect(push).toHaveBeenCalledTimes(1)
  })

  it('tracks each note independently', async () => {
    const push = vi.fn().mockResolvedValue(true)
    const scheduler = new CrdtSnapshotScheduler(push, { quietMs: 30_000, maxWaitMs: 120_000 })

    scheduler.request('note-1')
    scheduler.request('note-2')
    expect(scheduler.getPendingNoteIds()).toEqual(['note-1', 'note-2'])

    await vi.advanceTimersByTimeAsync(30_000)
    expect(push).toHaveBeenCalledTimes(2)
    expect(push).toHaveBeenCalledWith('note-1')
    expect(push).toHaveBeenCalledWith('note-2')
    expect(scheduler.getPendingNoteIds()).toEqual([])
  })

  it('never runs two snapshots for the same note concurrently', async () => {
    let resolveFirst: (() => void) | undefined
    const push = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValue(true)
    const scheduler = new CrdtSnapshotScheduler(push, { quietMs: 1000, maxWaitMs: 120_000 })

    scheduler.request('note-1')
    await vi.advanceTimersByTimeAsync(1000)
    expect(push).toHaveBeenCalledTimes(1)

    // Second request lands while the first upload is still in flight.
    scheduler.request('note-1')
    await vi.advanceTimersByTimeAsync(1000)
    expect(push).toHaveBeenCalledTimes(1)

    resolveFirst?.()
    await vi.advanceTimersByTimeAsync(1000)
    expect(push).toHaveBeenCalledTimes(2)
  })

  it('swallows push failures so a rejected snapshot cannot escape the timer', async () => {
    const push = vi.fn().mockRejectedValue(new Error('offline'))
    const scheduler = new CrdtSnapshotScheduler(push, { quietMs: 1000, maxWaitMs: 120_000 })

    scheduler.request('note-1')
    await vi.advanceTimersByTimeAsync(1000)
    expect(push).toHaveBeenCalledTimes(1)

    // A failed push must not wedge the note: the next request still schedules.
    push.mockResolvedValueOnce(true)
    scheduler.request('note-1')
    await vi.advanceTimersByTimeAsync(1000)
    expect(push).toHaveBeenCalledTimes(2)
  })

  it('drops pending work and ignores later requests after stop', async () => {
    const push = vi.fn().mockResolvedValue(true)
    const scheduler = new CrdtSnapshotScheduler(push, { quietMs: 1000, maxWaitMs: 120_000 })

    scheduler.request('note-1')
    scheduler.stop()
    scheduler.request('note-2')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(push).not.toHaveBeenCalled()
    expect(scheduler.getPendingNoteIds()).toEqual([])
  })
})
