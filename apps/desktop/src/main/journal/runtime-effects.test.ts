import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../sync/crdt-external-feed', () => ({ feedExternalEditToCrdt: vi.fn() }))
vi.mock('../sync/crdt-provider', () => ({ getCrdtProvider: vi.fn() }))
vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn()
}))

import { feedExternalEditToCrdt } from '../sync/crdt-external-feed'
import { feedJournalBodyToCrdt } from './runtime-effects'

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
