import { publishProjectionEvent } from '../projections'
import { emitCalendarProjectionChanged } from '../calendar/change-events'
import { scheduleGoogleCalendarSourceSync } from '../calendar/google/local-sync-effects'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'

export function syncTaskCreate(taskId: string): void {
  enqueueLocalSyncCreate('task', taskId)

  publishProjectionEvent({
    type: 'task.upserted',
    taskId
  })
  emitCalendarProjectionChanged(`task:${taskId}`)
  scheduleGoogleCalendarSourceSync({ sourceType: 'task', sourceId: taskId })
}

export function syncTaskUpdate(taskId: string, changedFields: string[]): void {
  enqueueLocalSyncUpdate('task', taskId, changedFields)

  publishProjectionEvent({
    type: 'task.upserted',
    taskId
  })
  emitCalendarProjectionChanged(`task:${taskId}`)
  scheduleGoogleCalendarSourceSync({ sourceType: 'task', sourceId: taskId })
}

export function syncTaskDelete(taskId: string, snapshot?: unknown): void {
  if (snapshot) {
    enqueueLocalSyncDelete('task', taskId, JSON.stringify(snapshot))
  }

  publishProjectionEvent({ type: 'task.deleted', taskId })
  emitCalendarProjectionChanged(`task:${taskId}`)
  scheduleGoogleCalendarSourceSync({ sourceType: 'task', sourceId: taskId })
}

export function syncProjectCreate(projectId: string): void {
  enqueueLocalSyncCreate('project', projectId)
}

export function syncProjectUpdate(projectId: string, changedFields?: string[]): void {
  enqueueLocalSyncUpdate('project', projectId, changedFields)
}

export function syncProjectDelete(projectId: string, snapshot?: unknown): void {
  if (snapshot) {
    enqueueLocalSyncDelete('project', projectId, JSON.stringify(snapshot))
  }
}
