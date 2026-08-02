import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import {
  enqueueBookmarkCreate,
  enqueueBookmarkUpdate,
  enqueueBookmarkDelete
} from './runtime-effects'

describe('bookmarks runtime effects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('#when enqueueBookmarkCreate called', () => {
    it('#then enqueues a local sync create for the bookmark type', () => {
      enqueueBookmarkCreate('bm-1')

      expect(mocks.enqueueLocalSyncCreate).toHaveBeenCalledWith('bookmark', 'bm-1')
    })
  })

  describe('#when enqueueBookmarkUpdate called', () => {
    it('#then enqueues a local sync update for the bookmark type', () => {
      enqueueBookmarkUpdate('bm-1')

      expect(mocks.enqueueLocalSyncUpdate).toHaveBeenCalledWith('bookmark', 'bm-1')
    })
  })

  describe('#given a snapshot #when enqueueBookmarkDelete called', () => {
    it('#then enqueues a local sync delete with the snapshot JSON-stringified', () => {
      enqueueBookmarkDelete('bm-1', { id: 'bm-1', itemType: 'note', itemId: 'note-1' })

      expect(mocks.enqueueLocalSyncDelete).toHaveBeenCalledWith(
        'bookmark',
        'bm-1',
        JSON.stringify({ id: 'bm-1', itemType: 'note', itemId: 'note-1' })
      )
    })
  })

  describe('#given no snapshot #when enqueueBookmarkDelete called', () => {
    it('#then no-ops instead of enqueuing a delete without a snapshot', () => {
      enqueueBookmarkDelete('bm-1', undefined)

      expect(mocks.enqueueLocalSyncDelete).not.toHaveBeenCalled()
    })

    it('#then no-ops for a falsy but present snapshot value', () => {
      enqueueBookmarkDelete('bm-1', null)

      expect(mocks.enqueueLocalSyncDelete).not.toHaveBeenCalled()
    })
  })
})
