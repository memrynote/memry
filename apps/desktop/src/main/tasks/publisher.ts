import { BrowserWindow } from 'electron'
import type { TasksDomainPublisher } from '@memry/domain-tasks'
import { TasksChannels } from '@memry/contracts/ipc-channels'

import {
  syncProjectCreate,
  syncProjectDelete,
  syncProjectUpdate,
  syncTaskCreate,
  syncTaskDelete,
  syncTaskUpdate
} from './runtime-effects'
import { trackMainEvent } from '../telemetry/track'

function emitTaskEvent(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
}

export function createTasksPublisher(): TasksDomainPublisher {
  return {
    taskCreated: ({ task }) => {
      emitTaskEvent(TasksChannels.events.CREATED, { task })
      syncTaskCreate(task.id)
      trackMainEvent('task_created', {
        surface: 'tasks',
        action: 'created',
        objectType: 'task',
        result: 'success'
      })
    },
    taskUpdated: ({ id, task, changes, changedFields }) => {
      emitTaskEvent(TasksChannels.events.UPDATED, { id, task, changes })
      syncTaskUpdate(id, changedFields)
    },
    taskDeleted: ({ id, snapshot }) => {
      syncTaskDelete(id, snapshot)
      emitTaskEvent(TasksChannels.events.DELETED, { id })
    },
    taskCompleted: ({ id, task }) => {
      emitTaskEvent(TasksChannels.events.COMPLETED, { id, task })
      syncTaskUpdate(id, ['completedAt'])
      trackMainEvent('task_completed', {
        surface: 'tasks',
        action: 'completed',
        objectType: 'task',
        result: 'success'
      })
    },
    taskMoved: ({ id, task, changedFields }) => {
      emitTaskEvent(TasksChannels.events.MOVED, { id, task })
      syncTaskUpdate(id, changedFields)
    },
    taskReordered: ({ id, changedFields }) => {
      syncTaskUpdate(id, changedFields)
    },
    projectCreated: ({ project }) => {
      emitTaskEvent(TasksChannels.events.PROJECT_CREATED, { project })
      syncProjectCreate(project.id)
      trackMainEvent('project_created', {
        surface: 'tasks',
        action: 'created',
        objectType: 'project',
        result: 'success'
      })
    },
    projectUpdated: ({ id, project, changedFields }) => {
      emitTaskEvent(TasksChannels.events.PROJECT_UPDATED, { id, project })
      syncProjectUpdate(id, changedFields)
    },
    projectDeleted: ({ id, snapshot }) => {
      syncProjectDelete(id, snapshot)
      emitTaskEvent(TasksChannels.events.PROJECT_DELETED, { id })
    },
    statusCreated: ({ status }) => {
      syncProjectUpdate(status.projectId)
    },
    statusUpdated: ({ status }) => {
      syncProjectUpdate(status.projectId)
    },
    statusDeleted: ({ projectId }) => {
      syncProjectUpdate(projectId)
    }
  }
}
