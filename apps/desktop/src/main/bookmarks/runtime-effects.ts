import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'

export function enqueueBookmarkCreate(bookmarkId: string): void {
  enqueueLocalSyncCreate('bookmark', bookmarkId)
}

export function enqueueBookmarkUpdate(bookmarkId: string): void {
  enqueueLocalSyncUpdate('bookmark', bookmarkId)
}

export function enqueueBookmarkDelete(bookmarkId: string, snapshot?: unknown): void {
  if (!snapshot) return
  enqueueLocalSyncDelete('bookmark', bookmarkId, JSON.stringify(snapshot))
}
