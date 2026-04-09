import { describe, expect, it, vi } from 'vitest'

const rebuildInboxStatsTable = vi.hoisted(() => vi.fn())

vi.mock('../../inbox/stats', () => ({
  rebuildInboxStatsTable
}))

import { createInboxStatsProjector } from './inbox-stats-projector'

describe('inbox stats projector', () => {
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
})
