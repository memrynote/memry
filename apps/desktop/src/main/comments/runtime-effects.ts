import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'

export function syncCommentCreate(commentId: string): void {
  enqueueLocalSyncCreate('comment', commentId)
}

export function syncCommentUpdate(commentId: string): void {
  enqueueLocalSyncUpdate('comment', commentId)
}

export function syncCommentDelete(commentId: string, snapshot: string): void {
  enqueueLocalSyncDelete('comment', commentId, snapshot)
}
