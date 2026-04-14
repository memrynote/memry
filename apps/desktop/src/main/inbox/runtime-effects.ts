import { publishProjectionEvent } from '../projections'
import { emitCalendarProjectionChanged } from '../calendar/change-events'
import { scheduleGoogleCalendarSourceSync } from '../calendar/google/local-sync-effects'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'

export function syncInboxCreate(itemId: string): void {
  enqueueLocalSyncCreate('inbox', itemId)

  publishInboxUpserted(itemId)
  emitCalendarProjectionChanged(`inbox:${itemId}`)
  scheduleGoogleCalendarSourceSync({ sourceType: 'inbox_snooze', sourceId: itemId })
}

export function syncInboxUpdate(itemId: string): void {
  enqueueLocalSyncUpdate('inbox', itemId)

  publishInboxUpserted(itemId)
  emitCalendarProjectionChanged(`inbox:${itemId}`)
  scheduleGoogleCalendarSourceSync({ sourceType: 'inbox_snooze', sourceId: itemId })
}

export function syncInboxDelete(itemId: string, snapshot: string): void {
  enqueueLocalSyncDelete('inbox', itemId, snapshot)
  publishProjectionEvent({ type: 'inbox.deleted', itemId })
  emitCalendarProjectionChanged(`inbox:${itemId}`)
  scheduleGoogleCalendarSourceSync({ sourceType: 'inbox_snooze', sourceId: itemId })
}

export function publishInboxUpserted(itemId: string): void {
  publishProjectionEvent({
    type: 'inbox.upserted',
    itemId
  })
}
