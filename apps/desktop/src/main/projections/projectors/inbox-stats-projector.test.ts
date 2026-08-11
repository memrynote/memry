import { afterEach, describe, expect, it, vi } from 'vitest'

const rebuildInboxStatsTable = vi.hoisted(() => vi.fn())

vi.mock('../../inbox/stats', () => ({
  rebuildInboxStatsTable
}))

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

import { INBOX_STATS_REBUILD_INTERVAL_MS, createInboxStatsProjector } from './inbox-stats-projector'
import type { ProjectionEvent } from '../types'

const upserted = (itemId: string): ProjectionEvent => ({ type: 'inbox.upserted', itemId })

describe('inbox stats projector', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rebuild delegates to inbox stats table rebuild', async () => {
    rebuildInboxStatsTable.mockReturnValue({ rows: 3 })

    const projector = createInboxStatsProjector()

    await expect(projector.rebuild()).resolves.toEqual({ rows: 3 })
    expect(rebuildInboxStatsTable).toHaveBeenCalledTimes(1)
  })

  it('reconcile delegates to inbox stats table rebuild', async () => {
    rebuildInboxStatsTable.mockReturnValue({ rows: 5 })

    const projector = createInboxStatsProjector()

    await expect(projector.reconcile()).resolves.toEqual({ rows: 5 })
    expect(rebuildInboxStatsTable).toHaveBeenCalledTimes(1)
  })

  it('rebuilds immediately for an isolated event so stats stay fresh', async () => {
    vi.useFakeTimers()
    rebuildInboxStatsTable.mockReturnValue({ rows: 1 })

    const projector = createInboxStatsProjector()
    await projector.project(upserted('item-1'))

    expect(rebuildInboxStatsTable).toHaveBeenCalledTimes(1)
  })

  it('coalesces a burst of inbox events into a small constant number of rebuilds', async () => {
    vi.useFakeTimers()
    rebuildInboxStatsTable.mockReturnValue({ rows: 1 })

    const projector = createInboxStatsProjector()

    for (let i = 0; i < 100; i++) {
      await projector.project(upserted(`item-${i}`))
    }

    // Leading edge only: the other 99 events collapse into one trailing rebuild.
    expect(rebuildInboxStatsTable).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(INBOX_STATS_REBUILD_INTERVAL_MS)

    expect(rebuildInboxStatsTable).toHaveBeenCalledTimes(2)

    // No extra rebuild is left armed once the burst has been flushed.
    await vi.advanceTimersByTimeAsync(INBOX_STATS_REBUILD_INTERVAL_MS * 10)
    expect(rebuildInboxStatsTable).toHaveBeenCalledTimes(2)
  })

  it('rebuilds again for an event that arrives after the coalescing window', async () => {
    vi.useFakeTimers()
    rebuildInboxStatsTable.mockReturnValue({ rows: 1 })

    const projector = createInboxStatsProjector()

    await projector.project(upserted('item-1'))
    expect(rebuildInboxStatsTable).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(INBOX_STATS_REBUILD_INTERVAL_MS)

    await projector.project(upserted('item-2'))
    expect(rebuildInboxStatsTable).toHaveBeenCalledTimes(2)
  })

  it('drops a pending coalesced rebuild when a full rebuild runs', async () => {
    vi.useFakeTimers()
    rebuildInboxStatsTable.mockReturnValue({ rows: 1 })

    const projector = createInboxStatsProjector()

    await projector.project(upserted('item-1'))
    await projector.project(upserted('item-2'))
    expect(rebuildInboxStatsTable).toHaveBeenCalledTimes(1)

    await projector.rebuild()
    expect(rebuildInboxStatsTable).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(INBOX_STATS_REBUILD_INTERVAL_MS * 10)
    expect(rebuildInboxStatsTable).toHaveBeenCalledTimes(2)
  })

  it('keeps the queue alive when a coalesced rebuild throws', async () => {
    vi.useFakeTimers()
    rebuildInboxStatsTable.mockReturnValue({ rows: 1 })

    const projector = createInboxStatsProjector()

    await projector.project(upserted('item-1'))
    await projector.project(upserted('item-2'))

    rebuildInboxStatsTable.mockImplementationOnce(() => {
      throw new Error('database closed')
    })

    await vi.advanceTimersByTimeAsync(INBOX_STATS_REBUILD_INTERVAL_MS)

    expect(rebuildInboxStatsTable).toHaveBeenCalledTimes(2)
  })
})
