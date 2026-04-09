/* eslint-disable @typescript-eslint/require-await */

import { BrowserWindow, ipcMain } from 'electron'
import type { TasksDomainPublisher } from '@memry/domain-tasks'
import { TasksChannels } from '@memry/contracts/ipc-channels'
import {
  BulkIdsSchema,
  BulkMoveSchema,
  ConvertToSubtaskSchema,
  GetUpcomingSchema,
  ProjectCreateSchema,
  ProjectReorderSchema,
  ProjectUpdateSchema,
  StatusCreateSchema,
  StatusReorderSchema,
  StatusUpdateSchema,
  TaskCompleteSchema,
  TaskCreateSchema,
  TaskListSchema,
  TaskMoveSchema,
  TaskReorderSchema,
  TaskUpdateSchema
} from '@memry/contracts/tasks-api'
import { requireDatabase, type DataDb } from '../database'
import { createLogger } from '../lib/logger'
import { generateId } from '../lib/id'
import { createHandler, createStringHandler, createValidatedHandler, withDb } from './validate'
import { createDesktopTasksDomain } from '../tasks/domain'
import {
  syncProjectCreate,
  syncProjectDelete,
  syncProjectUpdate,
  syncTaskCreate,
  syncTaskDelete,
  syncTaskUpdate
} from '../tasks/runtime-effects'

const logger = createLogger('IPC:Tasks')

function emitTaskEvent(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
}

function createTasksPublisher(): TasksDomainPublisher {
  return {
    taskCreated: ({ task }) => {
      emitTaskEvent(TasksChannels.events.CREATED, { task })
      syncTaskCreate(task.id)
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

function createTaskDomain(db: DataDb) {
  return createDesktopTasksDomain(db, createTasksPublisher(), generateId)
}

export function registerTasksHandlers(): void {
  ipcMain.handle(
    TasksChannels.invoke.CREATE,
    createValidatedHandler(
      TaskCreateSchema,
      withDb((db, input) => createTaskDomain(db).createTask(input), 'Failed to create task')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.GET,
    createStringHandler(async (id) => createTaskDomain(requireDatabase()).getTask(id))
  )

  ipcMain.handle(
    TasksChannels.invoke.UPDATE,
    createValidatedHandler(
      TaskUpdateSchema,
      withDb((db, input) => createTaskDomain(db).updateTask(input), 'Failed to update task')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.DELETE,
    createStringHandler(
      withDb((db, id) => createTaskDomain(db).deleteTask(id), 'Failed to delete task')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.LIST,
    createValidatedHandler(TaskListSchema, async (input) =>
      createTaskDomain(requireDatabase()).listTasks(input)
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.COMPLETE,
    createValidatedHandler(
      TaskCompleteSchema,
      withDb((db, input) => createTaskDomain(db).completeTask(input), 'Failed to complete task')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.UNCOMPLETE,
    createStringHandler(
      withDb((db, id) => createTaskDomain(db).uncompleteTask(id), 'Failed to uncomplete task')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.ARCHIVE,
    createStringHandler(
      withDb((db, id) => createTaskDomain(db).archiveTask(id), 'Failed to archive task')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.UNARCHIVE,
    createStringHandler(
      withDb((db, id) => createTaskDomain(db).unarchiveTask(id), 'Failed to unarchive task')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.MOVE,
    createValidatedHandler(
      TaskMoveSchema,
      withDb((db, input) => createTaskDomain(db).moveTask(input), 'Failed to move task')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.REORDER,
    createValidatedHandler(
      TaskReorderSchema,
      withDb(
        (db, input) => createTaskDomain(db).reorderTasks(input.taskIds, input.positions),
        'Failed to reorder tasks'
      )
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.DUPLICATE,
    createStringHandler(
      withDb((db, id) => createTaskDomain(db).duplicateTask(id), 'Failed to duplicate task')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.GET_SUBTASKS,
    createStringHandler(async (parentId) =>
      createTaskDomain(requireDatabase()).getSubtasks(parentId)
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.CONVERT_TO_SUBTASK,
    createValidatedHandler(
      ConvertToSubtaskSchema,
      withDb(
        (db, input) => createTaskDomain(db).convertToSubtask(input.taskId, input.parentId),
        'Failed to convert to subtask'
      )
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.CONVERT_TO_TASK,
    createStringHandler(
      withDb((db, id) => createTaskDomain(db).convertToTask(id), 'Failed to convert to task')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_CREATE,
    createValidatedHandler(
      ProjectCreateSchema,
      withDb((db, input) => createTaskDomain(db).createProject(input), 'Failed to create project')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_GET,
    createStringHandler(async (id) => createTaskDomain(requireDatabase()).getProject(id))
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_UPDATE,
    createValidatedHandler(
      ProjectUpdateSchema,
      withDb((db, input) => createTaskDomain(db).updateProject(input), 'Failed to update project')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_DELETE,
    createStringHandler(
      withDb((db, id) => createTaskDomain(db).deleteProject(id), 'Failed to delete project')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_LIST,
    createHandler(async () => createTaskDomain(requireDatabase()).listProjects())
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_ARCHIVE,
    createStringHandler(
      withDb((db, id) => createTaskDomain(db).archiveProject(id), 'Failed to archive project')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_REORDER,
    createValidatedHandler(
      ProjectReorderSchema,
      withDb(
        (db, input) => createTaskDomain(db).reorderProjects(input.projectIds, input.positions),
        'Failed to reorder projects'
      )
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.STATUS_CREATE,
    createValidatedHandler(
      StatusCreateSchema,
      withDb((db, input) => createTaskDomain(db).createStatus(input), 'Failed to create status')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.STATUS_UPDATE,
    createValidatedHandler(
      StatusUpdateSchema,
      withDb((db, input) => createTaskDomain(db).updateStatus(input), 'Failed to update status')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.STATUS_DELETE,
    createStringHandler(
      withDb((db, id) => createTaskDomain(db).deleteStatus(id), 'Failed to delete status')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.STATUS_REORDER,
    createValidatedHandler(
      StatusReorderSchema,
      withDb(
        (db, input) => createTaskDomain(db).reorderStatuses(input.statusIds, input.positions),
        'Failed to reorder statuses'
      )
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.STATUS_LIST,
    createStringHandler(async (projectId) =>
      createTaskDomain(requireDatabase()).listStatuses(projectId)
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.GET_TAGS,
    createHandler(async () => createTaskDomain(requireDatabase()).getTags())
  )

  ipcMain.handle(
    TasksChannels.invoke.BULK_COMPLETE,
    createValidatedHandler(
      BulkIdsSchema,
      withDb(
        (db, input) => createTaskDomain(db).bulkComplete(input.ids),
        'Failed to complete tasks'
      )
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.BULK_DELETE,
    createValidatedHandler(
      BulkIdsSchema,
      withDb((db, input) => createTaskDomain(db).bulkDelete(input.ids), 'Failed to delete tasks')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.BULK_MOVE,
    createValidatedHandler(
      BulkMoveSchema,
      withDb(
        (db, input) => createTaskDomain(db).bulkMove(input.ids, input.projectId),
        'Failed to move tasks'
      )
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.BULK_ARCHIVE,
    createValidatedHandler(
      BulkIdsSchema,
      withDb((db, input) => createTaskDomain(db).bulkArchive(input.ids), 'Failed to archive tasks')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.GET_STATS,
    createHandler(async () => createTaskDomain(requireDatabase()).getStats())
  )

  ipcMain.handle(
    TasksChannels.invoke.GET_TODAY,
    createHandler(async () => createTaskDomain(requireDatabase()).getToday())
  )

  ipcMain.handle(
    TasksChannels.invoke.GET_UPCOMING,
    createValidatedHandler(GetUpcomingSchema, async (input) =>
      createTaskDomain(requireDatabase()).getUpcoming(input.days)
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.GET_OVERDUE,
    createHandler(async () => createTaskDomain(requireDatabase()).getOverdue())
  )

  ipcMain.handle(
    TasksChannels.invoke.GET_LINKED_TASKS,
    createStringHandler(async (noteId) =>
      createTaskDomain(requireDatabase()).getLinkedTasks(noteId)
    )
  )

  ipcMain.handle(
    'tasks:seed-performance-test',
    createHandler(() => ({ success: true, message: '' }))
  )
  ipcMain.handle(
    'tasks:seed-demo',
    createHandler(() => ({ success: true, message: '' }))
  )

  logger.info('Tasks handlers registered')
}

export function unregisterTasksHandlers(): void {
  Object.values(TasksChannels.invoke).forEach((channel) => {
    ipcMain.removeHandler(channel)
  })
  ipcMain.removeHandler('tasks:seed-performance-test')
  ipcMain.removeHandler('tasks:seed-demo')
  logger.info('Tasks handlers unregistered')
}
