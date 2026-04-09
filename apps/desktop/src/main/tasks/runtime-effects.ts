import { publishProjectionEvent } from '../projections'
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
}

export function syncTaskUpdate(taskId: string, changedFields: string[]): void {
  enqueueLocalSyncUpdate('task', taskId, changedFields)

  publishProjectionEvent({
    type: 'task.upserted',
    taskId
  })
}

export function syncTaskDelete(taskId: string, snapshot?: unknown): void {
  if (snapshot) {
    enqueueLocalSyncDelete('task', taskId, JSON.stringify(snapshot))
  }

  publishProjectionEvent({ type: 'task.deleted', taskId })
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
