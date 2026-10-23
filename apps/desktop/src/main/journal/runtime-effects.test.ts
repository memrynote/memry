import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../sync/crdt-external-feed', () => ({ feedExternalEditToCrdt: vi.fn() }))
vi.mock('../sync/crdt-provider', () => ({ getCrdtProvider: vi.fn() }))
vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn()
}))

import { feedExternalEditToCrdt } from '../sync/crdt-external-feed'
import { getCrdtProvider } from '../sync/crdt-provider'
import { enqueueLocalSyncDelete } from '../sync/local-mutations'
import { enqueueJournalDelete, feedJournalBodyToCrdt } from './runtime-effects'

// #3037: the day's doc is loaded while the delete is raised, so its tombstone
// carries the doc's body state vector.
describe('enqueueJournalDelete', () => {
  it('raises the delete with the day doc loaded', async () => {
    const withDocLoaded = vi.fn(async (_id: string, enqueue: () => void) => {
      enqueue()
    })
    vi.mocked(getCrdtProvider).mockReturnValue({ withDocLoaded } as never)

    await enqueueJournalDelete('j2026-10-09', '2026-10-09')

    expect(withDocLoaded).toHaveBeenCalledWith('j2026-10-09', expect.any(Function))
    expect(enqueueLocalSyncDelete).toHaveBeenCalledWith('journal', 'j2026-10-09', '2026-10-09')
  })
})

describe('feedJournalBodyToCrdt', () => {
  beforeEach(() => vi.clearAllMocks())

  it('feeds the saved body into the entry doc', async () => {
    vi.mocked(feedExternalEditToCrdt).mockResolvedValue(true)
    await feedJournalBodyToCrdt('entry-1', 'new body')
    expect(feedExternalEditToCrdt).toHaveBeenCalledWith('entry-1', 'new body')
  })

  // The file is already written when this runs, so the save must still succeed.
  it('does not fail the save when the feed rejects', async () => {
    vi.mocked(feedExternalEditToCrdt).mockRejectedValue(new Error('doc closed'))
    await expect(feedJournalBodyToCrdt('entry-1', 'new body')).resolves.toBeUndefined()
  })
})
