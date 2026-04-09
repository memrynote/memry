import { publishProjectionEvent } from '../projections'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'

export function syncInboxCreate(itemId: string): void {
  enqueueLocalSyncCreate('inbox', itemId)

  publishInboxUpserted(itemId)
}

export function syncInboxUpdate(itemId: string): void {
  enqueueLocalSyncUpdate('inbox', itemId)

  publishInboxUpserted(itemId)
}

export function syncInboxDelete(itemId: string, snapshot: string): void {
  enqueueLocalSyncDelete('inbox', itemId, snapshot)
  publishProjectionEvent({ type: 'inbox.deleted', itemId })
}

export function publishInboxUpserted(itemId: string): void {
  publishProjectionEvent({
    type: 'inbox.upserted',
    itemId
  })
}
