import type { TasksDomainPublisher } from '@memry/domain-tasks'
import { TasksChannels } from '@memry/contracts/ipc-channels'
import { toSafeToken } from '@memry/contracts/telemetry-api'

import { publishTaskChanged, publishTaskRemoved } from './runtime-effects'
import { removeTaskLineFromSourceNote } from './remove-task-line-from-note'
import { trackMainEvent } from '../telemetry/track'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import {
  recordTaskCompleted,
  recordTaskCreated,
  recordTaskDeleted,
  recordTaskMoved,
  recordTaskUpdated
} from './activity-log'

function emitTaskEvent(channel: string, data: unknown): void {
  broadcastToAllWindows(channel, data)
}

// Field NAMES only (dueDate, priority, statusId, ...) — never values.
function changedFieldsDimension(changedFields: string[] | undefined): string {
  return toSafeToken([...(changedFields ?? [])].sort().join('_'), 'unknown')
}

// Task tags share the global tag list (see getTagsWithCounts). The tag hooks
// (useTags / useAllTags / useNoteTagsQuery) only refetch on `notes:tags-changed`,
// so a task tag mutation must broadcast it or the list stays stale until restart.
function emitTagsChanged(): void {
  emitTaskEvent('notes:tags-changed', {})
}

/**
 * Runs after the domain's unit of work has committed. Sync for tasks and
 * projects is not here: it commits with the row (tasks/sync-intents.ts, #2301).
 */
export function createTasksPublisher(): TasksDomainPublisher {
  return {
    taskCreated: ({ task }) => {
      emitTaskEvent(TasksChannels.events.CREATED, { task })
      if (task.tags && task.tags.length > 0) emitTagsChanged()
      recordTaskCreated(task)
      publishTaskChanged(task.id)
      trackMainEvent('task_created', {
        surface: 'tasks',
        action: 'created',
        objectType: 'task',
        result: 'success'
      })
    },
    taskUpdated: ({ id, task, changes, changedFields, previous }) => {
      emitTaskEvent(TasksChannels.events.UPDATED, { id, task, changes })
      if (changedFields.includes('tags')) emitTagsChanged()
      recordTaskUpdated({ id, task, changes, changedFields, previous })
      publishTaskChanged(id)
      trackMainEvent('task_updated', {
        surface: 'tasks',
        action: 'updated',
        objectType: 'task',
        result: 'success',
        dimensions: { changed_fields: changedFieldsDimension(changedFields) }
      })
    },
    taskDeleted: async ({ id, snapshot }) => {
      recordTaskDeleted(id, snapshot)
      publishTaskRemoved(id)
      emitTaskEvent(TasksChannels.events.DELETED, { id })
      if (snapshot?.tags && snapshot.tags.length > 0) emitTagsChanged()
      trackMainEvent('task_deleted', {
        surface: 'tasks',
        action: 'deleted',
        objectType: 'task',
        result: 'success'
      })
      if (snapshot?.sourceNoteId) await removeTaskLineFromSourceNote(id, snapshot.sourceNoteId)
    },
    taskCompleted: ({ id, task, previous }) => {
      emitTaskEvent(TasksChannels.events.COMPLETED, { id, task })
      recordTaskCompleted({ id, task, previous })
      publishTaskChanged(id)
      trackMainEvent('task_completed', {
        surface: 'tasks',
        action: 'completed',
        objectType: 'task',
        result: 'success'
      })
    },
    taskMoved: ({ id, task, changedFields, previous }) => {
      emitTaskEvent(TasksChannels.events.MOVED, { id, task })
      recordTaskMoved({ id, task, changedFields, previous })
      publishTaskChanged(id)
    },
    // Deliberately no activity row: reorder only ever changes `position`, which
    // the activity writer filters out anyway, and a 200-task drag would call
    // this 200 times.
    taskReordered: ({ id }) => {
      publishTaskChanged(id)
    },
    projectCreated: ({ project }) => {
      emitTaskEvent(TasksChannels.events.PROJECT_CREATED, { project })
      trackMainEvent('project_created', {
        surface: 'tasks',
        action: 'created',
        objectType: 'project',
        result: 'success'
      })
    },
    projectUpdated: ({ id, project, changedFields }) => {
      emitTaskEvent(TasksChannels.events.PROJECT_UPDATED, { id, project })
      // The archive flow routes through projectUpdated with
      // changedFields ['archivedAt']; count it as its own lifecycle event.
      const archived = (changedFields ?? []).includes('archivedAt') && Boolean(project?.archivedAt)
      trackMainEvent(archived ? 'project_archived' : 'project_updated', {
        surface: 'tasks',
        action: archived ? 'archived' : 'updated',
        objectType: 'project',
        result: 'success',
        dimensions: { changed_fields: changedFieldsDimension(changedFields) }
      })
    },
    projectDeleted: ({ id }) => {
      emitTaskEvent(TasksChannels.events.PROJECT_DELETED, { id })
      trackMainEvent('project_deleted', {
        surface: 'tasks',
        action: 'deleted',
        objectType: 'project',
        result: 'success'
      })
    },
    statusCreated: () => {},
    statusUpdated: () => {},
    statusDeleted: () => {}
  }
}
