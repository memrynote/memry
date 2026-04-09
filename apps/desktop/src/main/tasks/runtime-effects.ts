import type { DataDb } from '../database'
import { publishProjectionEvent } from '../projections'
import { incrementProjectClocksOffline, incrementTaskClocksOffline } from '../sync/offline-clock'
import { getProjectSyncService } from '../sync/project-sync'
import { getTaskSyncService } from '../sync/task-sync'

export function syncTaskCreate(db: DataDb, taskId: string): void {
  const svc = getTaskSyncService()
  if (svc) {
    svc.enqueueCreate(taskId)
  } else {
    incrementTaskClocksOffline(db, taskId, [])
  }

  publishProjectionEvent({
    type: 'task.upserted',
    taskId
  })
}

export function syncTaskUpdate(db: DataDb, taskId: string, changedFields: string[]): void {
  const svc = getTaskSyncService()
  if (svc) {
    svc.enqueueUpdate(taskId, changedFields)
  } else {
    incrementTaskClocksOffline(db, taskId, changedFields)
  }

  publishProjectionEvent({
    type: 'task.upserted',
    taskId
  })
}

export function syncTaskDelete(taskId: string, snapshot?: unknown): void {
  const syncService = getTaskSyncService()
  if (syncService && snapshot) {
    syncService.enqueueDelete(taskId, JSON.stringify(snapshot))
  }

  publishProjectionEvent({ type: 'task.deleted', taskId })
}

export function syncProjectCreate(db: DataDb, projectId: string): void {
  const svc = getProjectSyncService()
  if (svc) {
    svc.enqueueCreate(projectId)
  } else {
    incrementProjectClocksOffline(db, projectId)
  }
}

export function syncProjectUpdate(db: DataDb, projectId: string, changedFields?: string[]): void {
  const svc = getProjectSyncService()
  if (svc) {
    svc.enqueueUpdate(projectId, changedFields)
  } else {
    incrementProjectClocksOffline(db, projectId, changedFields)
  }
}

export function syncProjectDelete(projectId: string, snapshot?: unknown): void {
  const syncService = getProjectSyncService()
  if (syncService && snapshot) {
    syncService.enqueueDelete(projectId, JSON.stringify(snapshot))
  }
}
