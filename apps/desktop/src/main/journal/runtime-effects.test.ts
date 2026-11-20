import { describe, expect, it, vi } from 'vitest'

vi.mock('../sync/crdt-provider', () => ({ getCrdtProvider: vi.fn() }))
vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn()
}))

import { getCrdtProvider } from '../sync/crdt-provider'
import { enqueueLocalSyncDelete } from '../sync/local-mutations'
import { enqueueJournalDelete } from './runtime-effects'

// #3037: the day's doc is loaded while the delete is raised, so its tombstone
// carries the doc's body state vector.
describe('enqueueJournalDelete', () => {
  it('raises the delete with the day doc loaded', async () => {
    const withDocLoaded = vi.fn(async (_id: string, enqueue: () => void) => enqueue())
    vi.mocked(getCrdtProvider).mockReturnValue({ withDocLoaded } as never)

    await enqueueJournalDelete('j2026-10-09', '2026-10-09')

    expect(withDocLoaded).toHaveBeenCalledWith('j2026-10-09', expect.any(Function))
    expect(enqueueLocalSyncDelete).toHaveBeenCalledWith('journal', 'j2026-10-09', '2026-10-09')
  })
})
