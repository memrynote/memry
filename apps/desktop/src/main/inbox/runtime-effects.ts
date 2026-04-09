import { type DataDb } from '../database'
import { publishProjectionEvent } from '../projections'
import { getInboxSyncService } from '../sync/inbox-sync'
import { incrementInboxClockOffline } from '../sync/offline-clock'

export function syncInboxCreate(db: DataDb, itemId: string): void {
  const svc = getInboxSyncService()
  if (svc) {
    svc.enqueueCreate(itemId)
  } else {
    incrementInboxClockOffline(db, itemId)
  }

  publishInboxUpserted(itemId)
}

export function syncInboxUpdate(db: DataDb, itemId: string): void {
  const svc = getInboxSyncService()
  if (svc) {
    svc.enqueueUpdate(itemId)
  } else {
    incrementInboxClockOffline(db, itemId)
  }

  publishInboxUpserted(itemId)
}

export function syncInboxDelete(itemId: string, snapshot: string): void {
  getInboxSyncService()?.enqueueDelete(itemId, snapshot)
  publishProjectionEvent({ type: 'inbox.deleted', itemId })
}

export function publishInboxUpserted(itemId: string): void {
  publishProjectionEvent({
    type: 'inbox.upserted',
    itemId
  })
}
