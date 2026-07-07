import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))

vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: mocks.enqueueLocalSyncCreate,
  enqueueLocalSyncUpdate: mocks.enqueueLocalSyncUpdate,
  enqueueLocalSyncDelete: mocks.enqueueLocalSyncDelete
}))

import { syncFilterCreate, syncFilterUpdate, syncFilterDelete } from './saved-filters-sync'

describe('saved-filters-sync', () => {
  beforeEach(() => vi.clearAllMocks())

  it('enqueues create/update under the "filter" sync item type', () => {
    syncFilterCreate('filter-1')
    syncFilterUpdate('filter-1')

    expect(mocks.enqueueLocalSyncCreate).toHaveBeenCalledWith('filter', 'filter-1')
    expect(mocks.enqueueLocalSyncUpdate).toHaveBeenCalledWith('filter', 'filter-1')
  })

  it('forwards the tombstone snapshot on delete', () => {
    const snapshot = '{"id":"filter-1","clock":{"device":1}}'
    syncFilterDelete('filter-1', snapshot)

    expect(mocks.enqueueLocalSyncDelete).toHaveBeenCalledWith('filter', 'filter-1', snapshot)
  })
})
