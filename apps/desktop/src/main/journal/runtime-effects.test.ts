import { describe, expect, it, vi } from 'vitest'

vi.mock('../sync/crdt-provider', () => ({ getCrdtProvider: vi.fn() }))
vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  sendPendingContentDelete: vi.fn()
}))
vi.mock('../database', () => ({ getDatabase: vi.fn() }))
vi.mock('@memry/storage-data', () => ({ getNoteMetadataById: vi.fn(() => ({ id: 'row' })) }))
vi.mock('../sync/pending-deletes', () => ({
  coverPendingContentDeletes: vi.fn(() => []),
  isSupersededByLiveRow: vi.fn(),
  listUncoveredContentDeletes: vi.fn(() => [])
}))

import { getCrdtProvider } from '../sync/crdt-provider'
import { enqueueLocalSyncDelete } from '../sync/local-mutations'
import { enqueueJournalDelete } from './runtime-effects'

// #3037: the day's doc is loaded while the delete is raised, so its tombstone
// carries the doc's body state vector.
describe('enqueueJournalDelete', () => {
  it('raises the delete with the day doc loaded', async () => {
    const withDocLoaded = vi.fn(async (_id: string, enqueue: () => void) => enqueue())
    const purge = vi.fn(async () => undefined)
    vi.mocked(getCrdtProvider).mockReturnValue({
      withDocLoaded,
      purge,
      getStateVector: () => null
    } as never)

    await enqueueJournalDelete('j2026-10-09', '2026-10-09')

    expect(withDocLoaded).toHaveBeenCalledWith('j2026-10-09', expect.any(Function))
    expect(enqueueLocalSyncDelete).toHaveBeenCalledWith('journal', 'j2026-10-09', '2026-10-09')
    // #5353: a day written again after the delete starts a new body.
    expect(purge).toHaveBeenCalledWith('j2026-10-09')
  })
})
