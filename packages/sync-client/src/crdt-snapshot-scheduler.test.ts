import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CrdtSnapshotScheduler } from './crdt-snapshot-scheduler'

const WINDOW_MS = 2_000

describe('CrdtSnapshotScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces a burst of requests into one push after the quiet period', async () => {
    const push = vi.fn().mockResolvedValue(true)
    const scheduler = new CrdtSnapshotScheduler(push, {
      quietMs: 30_000,
      maxWaitMs: 120_000,
      batchWindowMs: WINDOW_MS
    })

    for (let i = 0; i < 20; i++) {
      scheduler.request('note-1')
      await vi.advanceTimersByTimeAsync(1000)
    }

    expect(push).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30_000 + WINDOW_MS)
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith(['note-1'])
  })

  it('still pushes during an uninterrupted run once the max wait elapses', async () => {
    const push = vi.fn().mockResolvedValue(true)
    const scheduler = new CrdtSnapshotScheduler(push, {
      quietMs: 30_000,
      maxWaitMs: 120_000,
      batchWindowMs: WINDOW_MS
    })

    // 200 s of typing at one batch per second never goes quiet, so only the
    // max-wait ceiling can release a snapshot.
    for (let i = 0; i < 200; i++) {
      scheduler.request('note-1')
      await vi.advanceTimersByTimeAsync(1000)
    }

    expect(push).toHaveBeenCalledTimes(1)
  })

  it('sends notes that come due together in one call', async () => {
    const push = vi.fn().mockResolvedValue(true)
    const scheduler = new CrdtSnapshotScheduler(push, {
      quietMs: 30_000,
      maxWaitMs: 120_000,
      batchWindowMs: WINDOW_MS
    })

    // #given 200 notes written a few ms apart, as an import writes them
    for (let i = 0; i < 200; i++) {
      scheduler.request(`note-${i}`)
      await vi.advanceTimersByTimeAsync(5)
    }
    expect(scheduler.getPendingNoteIds()).toHaveLength(200)

    // #when their quiet periods end and the batch window closes
    await vi.advanceTimersByTimeAsync(30_000 + WINDOW_MS)

    // #then one call carries all of them, not one call per note
    expect(push).toHaveBeenCalledTimes(1)
    expect(push.mock.calls[0][0]).toHaveLength(200)
    expect(scheduler.getPendingNoteIds()).toEqual([])
  })

  it('tracks each note independently', async () => {
    const push = vi.fn().mockResolvedValue(true)
    const scheduler = new CrdtSnapshotScheduler(push, {
      quietMs: 30_000,
      maxWaitMs: 120_000,
      batchWindowMs: WINDOW_MS
    })

    scheduler.request('note-1')
    await vi.advanceTimersByTimeAsync(10_000)
    scheduler.request('note-2')
    expect(scheduler.getPendingNoteIds()).toEqual(['note-1', 'note-2'])

    await vi.advanceTimersByTimeAsync(20_000 + WINDOW_MS)
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenLastCalledWith(['note-1'])
    expect(scheduler.getPendingNoteIds()).toEqual(['note-2'])

    await vi.advanceTimersByTimeAsync(10_000)
    expect(push).toHaveBeenCalledTimes(2)
    expect(push).toHaveBeenLastCalledWith(['note-2'])
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
    const scheduler = new CrdtSnapshotScheduler(push, {
      quietMs: 1000,
      maxWaitMs: 120_000,
      batchWindowMs: WINDOW_MS
    })

    scheduler.request('note-1')
    await vi.advanceTimersByTimeAsync(1000 + WINDOW_MS)
    expect(push).toHaveBeenCalledTimes(1)

    // Second request lands while the first upload is still in flight.
    scheduler.request('note-1')
    await vi.advanceTimersByTimeAsync(1000 + WINDOW_MS)
    expect(push).toHaveBeenCalledTimes(1)

    resolveFirst?.()
    await vi.advanceTimersByTimeAsync(1000 + WINDOW_MS)
    expect(push).toHaveBeenCalledTimes(2)
  })

  it('swallows push failures so a rejected snapshot cannot escape the timer', async () => {
    const push = vi.fn().mockRejectedValue(new Error('offline'))
    const scheduler = new CrdtSnapshotScheduler(push, {
      quietMs: 1000,
      maxWaitMs: 120_000,
      batchWindowMs: WINDOW_MS
    })

    scheduler.request('note-1')
    await vi.advanceTimersByTimeAsync(1000 + WINDOW_MS)
    expect(push).toHaveBeenCalledTimes(1)

    // A failed push must not wedge the note: the next request still schedules.
    push.mockResolvedValueOnce(true)
    scheduler.request('note-1')
    await vi.advanceTimersByTimeAsync(1000 + WINDOW_MS)
    expect(push).toHaveBeenCalledTimes(2)
  })

  it('drops pending work and ignores later requests after stop', async () => {
    const push = vi.fn().mockResolvedValue(true)
    const scheduler = new CrdtSnapshotScheduler(push, {
      quietMs: 1000,
      maxWaitMs: 120_000,
      batchWindowMs: WINDOW_MS
    })

    scheduler.request('note-1')
    scheduler.stop()
    scheduler.request('note-2')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(push).not.toHaveBeenCalled()
    expect(scheduler.getPendingNoteIds()).toEqual([])
  })

  it('drops notes already waiting for the batch window on stop', async () => {
    const push = vi.fn().mockResolvedValue(true)
    const scheduler = new CrdtSnapshotScheduler(push, {
      quietMs: 1000,
      maxWaitMs: 120_000,
      batchWindowMs: WINDOW_MS
    })

    scheduler.request('note-1')
    await vi.advanceTimersByTimeAsync(1000)
    expect(scheduler.getPendingNoteIds()).toEqual(['note-1'])

    scheduler.stop()
    await vi.advanceTimersByTimeAsync(WINDOW_MS)
    expect(push).not.toHaveBeenCalled()
    expect(scheduler.getPendingNoteIds()).toEqual([])
  })
})
