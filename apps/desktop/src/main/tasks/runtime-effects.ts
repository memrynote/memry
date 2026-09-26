import { publishProjectionEvent } from '../projections'
import { emitCalendarProjectionChanged } from '../calendar/change-events'
import { scheduleGoogleCalendarSourceSync } from '../calendar/google/local-sync-effects'

/** Projection, calendar and Google source effects of a task write. No sync. */
export function publishTaskChanged(taskId: string): void {
  publishProjectionEvent({
    type: 'task.upserted',
    taskId
  })
  emitCalendarProjectionChanged(`task:${taskId}`)
  scheduleGoogleCalendarSourceSync({ sourceType: 'task', sourceId: taskId })
}

/** Projection, calendar and Google source effects of a task delete. No sync. */
export function publishTaskRemoved(taskId: string): void {
  publishProjectionEvent({ type: 'task.deleted', taskId })
  emitCalendarProjectionChanged(`task:${taskId}`)
  scheduleGoogleCalendarSourceSync({ sourceType: 'task', sourceId: taskId })
}
