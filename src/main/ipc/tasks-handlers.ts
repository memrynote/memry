/**
 * Tasks IPC handlers.
 * Handles all task and project-related IPC communication from renderer.
 *
 * @module ipc/tasks-handlers
 */

/* eslint-disable @typescript-eslint/require-await */
// IPC handlers must be async for Electron compatibility, but use synchronous better-sqlite3 operations
// Electron IPC passes untyped arguments that are validated by Zod schemas in each handler

import { ipcMain, BrowserWindow } from 'electron'
import { TasksChannels } from '@shared/ipc-channels'
import {
  TaskCreateSchema,
  TaskUpdateSchema,
  TaskCompleteSchema,
  TaskMoveSchema,
  TaskListSchema,
  ProjectCreateSchema,
  ProjectUpdateSchema,
  StatusCreateSchema,
  StatusUpdateSchema,
  TaskReorderSchema,
  ConvertToSubtaskSchema,
  ProjectReorderSchema,
  StatusReorderSchema,
  BulkIdsSchema,
  BulkMoveSchema,
  GetUpcomingSchema
} from '@shared/contracts/tasks-api'
import { createLogger } from '../lib/logger'
import { createValidatedHandler, createHandler, createStringHandler } from './validate'
import { getDatabase, type DrizzleDb } from '../database'
import { generateId } from '../lib/id'
import * as taskQueries from '@shared/db/queries/tasks'
import * as projectQueries from '@shared/db/queries/projects'
import { getTaskSyncService } from '../sync/task-sync'
import { getProjectSyncService } from '../sync/project-sync'
import { incrementTaskClocksOffline, incrementProjectClocksOffline } from '../sync/offline-clock'

const logger = createLogger('IPC:Tasks')

function syncTaskUpdate(db: DrizzleDb, taskId: string, changedFields: string[]): void {
  const svc = getTaskSyncService()
  if (svc) {
    svc.enqueueUpdate(taskId, changedFields)
  } else {
    incrementTaskClocksOffline(db, taskId, changedFields)
  }
}

function syncTaskCreate(db: DrizzleDb, taskId: string): void {
  const svc = getTaskSyncService()
  if (svc) {
    svc.enqueueCreate(taskId)
  } else {
    incrementTaskClocksOffline(db, taskId, [])
  }
}

function syncProjectUpdate(db: DrizzleDb, projectId: string, changedFields?: string[]): void {
  const svc = getProjectSyncService()
  if (svc) {
    svc.enqueueUpdate(projectId, changedFields)
  } else {
    incrementProjectClocksOffline(db, projectId, changedFields)
  }
}

function syncProjectCreate(db: DrizzleDb, projectId: string): void {
  const svc = getProjectSyncService()
  if (svc) {
    svc.enqueueCreate(projectId)
  } else {
    incrementProjectClocksOffline(db, projectId)
  }
}

/**
 * Emit task event to all windows
 */
function emitTaskEvent(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
}

/**
 * Helper to get database, throwing a user-friendly error if not available.
 * Database is fetched lazily when handlers are called, not at registration time.
 */
function requireDatabase(): DrizzleDb {
  try {
    return getDatabase()
  } catch {
    throw new Error('No vault is open. Please open a vault first.')
  }
}

/**
 * Register all task-related IPC handlers.
 * Call this once during app initialization.
 */
export function registerTasksHandlers(): void {
  // ============================================================================
  // Task CRUD
  // ============================================================================

  // tasks:create - Create a new task
  ipcMain.handle(
    TasksChannels.invoke.CREATE,
    createValidatedHandler(TaskCreateSchema, async (input) => {
      try {
        const db = requireDatabase()
        const id = generateId()
        const position = taskQueries.getNextTaskPosition(db, input.projectId, input.parentId)

        const task = taskQueries.insertTask(db, {
          id,
          projectId: input.projectId,
          statusId: input.statusId ?? null,
          parentId: input.parentId ?? null,
          title: input.title,
          description: input.description ?? null,
          priority: input.priority ?? 0,
          position: input.position ?? position,
          dueDate: input.dueDate ?? null,
          dueTime: input.dueTime ?? null,
          startDate: input.startDate ?? null,
          repeatConfig: input.repeatConfig ?? null,
          repeatFrom: input.repeatFrom ?? null,
          sourceNoteId: input.sourceNoteId ?? null
        })

        // Set tags if provided
        if (input.tags && input.tags.length > 0) {
          taskQueries.setTaskTags(db, id, input.tags)
        }

        // Set linked notes if provided
        if (input.linkedNoteIds && input.linkedNoteIds.length > 0) {
          taskQueries.setTaskNotes(db, id, input.linkedNoteIds)
        }

        // Enrich task with linked note IDs for the response
        const enrichedTask = {
          ...task,
          linkedNoteIds: input.linkedNoteIds ?? []
        }

        emitTaskEvent(TasksChannels.events.CREATED, { task: enrichedTask })
        syncTaskCreate(db, id)

        return { success: true, task: enrichedTask }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create task'
        return { success: false, task: null, error: message }
      }
    })
  )

  // tasks:get - Get a task by ID
  ipcMain.handle(
    TasksChannels.invoke.GET,
    createStringHandler(async (id) => {
      const db = requireDatabase()
      const task = taskQueries.getTaskById(db, id)
      if (task) {
        const tags = taskQueries.getTaskTags(db, id)
        const linkedNoteIds = taskQueries.getTaskNoteIds(db, id)
        const subtaskCounts = taskQueries.countSubtasks(db, id)
        return {
          ...task,
          tags,
          linkedNoteIds,
          hasSubtasks: subtaskCounts.total > 0,
          subtaskCount: subtaskCounts.total,
          completedSubtaskCount: subtaskCounts.completed
        }
      }
      return null
    })
  )

  // tasks:update - Update a task
  ipcMain.handle(
    TasksChannels.invoke.UPDATE,
    createValidatedHandler(TaskUpdateSchema, async (input) => {
      try {
        const db = requireDatabase()
        const { id, tags, linkedNoteIds, ...updates } = input

        const existingTask = taskQueries.getTaskById(db, id)

        // If projectId is changing, we need to map the status to the new project
        if (updates.projectId) {
          if (existingTask && existingTask.projectId !== updates.projectId) {
            // Get the current status
            const currentStatus = existingTask.statusId
              ? projectQueries.getStatusById(db, existingTask.statusId)
              : undefined
            // Find equivalent status in the new project
            const newStatus = projectQueries.getEquivalentStatus(
              db,
              updates.projectId,
              currentStatus
            )
            if (newStatus) {
              updates.statusId = newStatus.id
            }
          }
        }

        const task = taskQueries.updateTask(db, id, updates)
        if (!task) {
          return { success: false, task: null, error: 'Task not found' }
        }

        // Update tags if provided
        if (tags !== undefined) {
          taskQueries.setTaskTags(db, id, tags)
        }

        // Update linked notes if provided
        if (linkedNoteIds !== undefined) {
          taskQueries.setTaskNotes(db, id, linkedNoteIds)
        }

        // Enrich task with linked note IDs for the response
        const enrichedTask = {
          ...task,
          linkedNoteIds: taskQueries.getTaskNoteIds(db, id)
        }

        const actualChanged = existingTask
          ? Object.keys(updates).filter((k) => {
              const oldVal = (existingTask as Record<string, unknown>)[k] ?? null
              const newVal = (updates as Record<string, unknown>)[k] ?? null
              return JSON.stringify(oldVal) !== JSON.stringify(newVal)
            })
          : Object.keys(updates)

        emitTaskEvent(TasksChannels.events.UPDATED, { id, task: enrichedTask, changes: updates })
        syncTaskUpdate(db, id, actualChanged)

        return { success: true, task: enrichedTask }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to update task'
        return { success: false, task: null, error: message }
      }
    })
  )

  // tasks:delete - Delete a task
  ipcMain.handle(
    TasksChannels.invoke.DELETE,
    createStringHandler(async (id) => {
      try {
        const db = requireDatabase()
        const syncService = getTaskSyncService()
        if (syncService) {
          const task = taskQueries.getTaskById(db, id)
          if (task) syncService.enqueueDelete(id, JSON.stringify(task))
        }
        taskQueries.deleteTask(db, id)
        emitTaskEvent(TasksChannels.events.DELETED, { id })
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete task'
        return { success: false, error: message }
      }
    })
  )

  // tasks:list - List tasks with filtering
  ipcMain.handle(
    TasksChannels.invoke.LIST,
    createValidatedHandler(TaskListSchema, async (input) => {
      const db = requireDatabase()
      const tasks = taskQueries.listTasks(db, input)
      const total = taskQueries.countTasks(db, {
        projectId: input.projectId,
        includeCompleted: input.includeCompleted,
        includeArchived: input.includeArchived
      })

      // Enrich tasks with additional data
      const enrichedTasks = tasks.map((task) => {
        const subtaskCounts = taskQueries.countSubtasks(db, task.id)
        const tags = taskQueries.getTaskTags(db, task.id)
        const linkedNoteIds = taskQueries.getTaskNoteIds(db, task.id)
        return {
          ...task,
          tags,
          linkedNoteIds,
          hasSubtasks: subtaskCounts.total > 0,
          subtaskCount: subtaskCounts.total,
          completedSubtaskCount: subtaskCounts.completed
        }
      })

      return {
        tasks: enrichedTasks,
        total,
        hasMore: (input.offset ?? 0) + tasks.length < total
      }
    })
  )

  // ============================================================================
  // Task Actions
  // ============================================================================

  // tasks:complete - Complete a task
  ipcMain.handle(
    TasksChannels.invoke.COMPLETE,
    createValidatedHandler(TaskCompleteSchema, async (input) => {
      try {
        const db = requireDatabase()
        const task = taskQueries.completeTask(db, input.id, input.completedAt)
        if (!task) {
          return { success: false, task: null, error: 'Task not found' }
        }

        const enrichedTask = {
          ...task,
          linkedNoteIds: taskQueries.getTaskNoteIds(db, input.id)
        }

        emitTaskEvent(TasksChannels.events.COMPLETED, { id: input.id, task: enrichedTask })
        syncTaskUpdate(db, input.id, ['completedAt'])

        return { success: true, task: enrichedTask }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to complete task'
        return { success: false, task: null, error: message }
      }
    })
  )

  // tasks:uncomplete - Uncomplete a task
  ipcMain.handle(
    TasksChannels.invoke.UNCOMPLETE,
    createStringHandler(async (id) => {
      try {
        const db = requireDatabase()
        const task = taskQueries.uncompleteTask(db, id)
        if (!task) {
          return { success: false, task: null, error: 'Task not found' }
        }

        const enrichedTask = {
          ...task,
          linkedNoteIds: taskQueries.getTaskNoteIds(db, id)
        }

        emitTaskEvent(TasksChannels.events.UPDATED, {
          id,
          task: enrichedTask,
          changes: { completedAt: null }
        })
        syncTaskUpdate(db, id, ['completedAt'])

        return { success: true, task: enrichedTask }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to uncomplete task'
        return { success: false, task: null, error: message }
      }
    })
  )

  // tasks:archive - Archive a task
  ipcMain.handle(
    TasksChannels.invoke.ARCHIVE,
    createStringHandler(async (id) => {
      try {
        const db = requireDatabase()
        const task = taskQueries.archiveTask(db, id)
        if (!task) {
          return { success: false, error: 'Task not found' }
        }
        // Enrich task with linked note IDs for the response
        const enrichedTask = {
          ...task,
          linkedNoteIds: taskQueries.getTaskNoteIds(db, id)
        }
        // Emit event so frontend can update state
        emitTaskEvent(TasksChannels.events.UPDATED, {
          id,
          task: enrichedTask,
          changes: { archivedAt: task.archivedAt }
        })
        syncTaskUpdate(db, id, ['archivedAt'])
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to archive task'
        return { success: false, error: message }
      }
    })
  )

  // tasks:unarchive - Unarchive a task
  ipcMain.handle(
    TasksChannels.invoke.UNARCHIVE,
    createStringHandler(async (id) => {
      try {
        const db = requireDatabase()
        const task = taskQueries.unarchiveTask(db, id)
        if (!task) {
          return { success: false, error: 'Task not found' }
        }
        // Enrich task with linked note IDs for the response
        const enrichedTask = {
          ...task,
          linkedNoteIds: taskQueries.getTaskNoteIds(db, id)
        }
        // Emit event so frontend can update state
        emitTaskEvent(TasksChannels.events.UPDATED, {
          id,
          task: enrichedTask,
          changes: { archivedAt: null }
        })
        syncTaskUpdate(db, id, ['archivedAt'])
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to unarchive task'
        return { success: false, error: message }
      }
    })
  )

  // tasks:move - Move a task
  ipcMain.handle(
    TasksChannels.invoke.MOVE,
    createValidatedHandler(TaskMoveSchema, async (input) => {
      try {
        const db = requireDatabase()

        // If moving to a different project and no statusId provided, map the status
        let targetStatusId = input.targetStatusId
        if (input.targetProjectId && !targetStatusId) {
          const currentTask = taskQueries.getTaskById(db, input.taskId)
          if (currentTask && currentTask.projectId !== input.targetProjectId) {
            const currentStatus = currentTask.statusId
              ? projectQueries.getStatusById(db, currentTask.statusId)
              : undefined
            const newStatus = projectQueries.getEquivalentStatus(
              db,
              input.targetProjectId,
              currentStatus
            )
            if (newStatus) {
              targetStatusId = newStatus.id
            }
          }
        }

        const task = taskQueries.moveTask(db, input.taskId, {
          projectId: input.targetProjectId,
          statusId: targetStatusId,
          parentId: input.targetParentId,
          position: input.position
        })

        if (!task) {
          return { success: false, task: null, error: 'Task not found' }
        }

        const enrichedTask = {
          ...task,
          linkedNoteIds: taskQueries.getTaskNoteIds(db, input.taskId)
        }

        const movedFields: string[] = ['position']
        if (input.targetProjectId) movedFields.push('projectId')
        if (targetStatusId) movedFields.push('statusId')
        if (input.targetParentId !== undefined) movedFields.push('parentId')
        emitTaskEvent(TasksChannels.events.MOVED, { id: input.taskId, task: enrichedTask })
        syncTaskUpdate(db, input.taskId, movedFields)

        return { success: true, task: enrichedTask }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to move task'
        return { success: false, task: null, error: message }
      }
    })
  )

  // tasks:reorder - Reorder tasks
  ipcMain.handle(
    TasksChannels.invoke.REORDER,
    createValidatedHandler(TaskReorderSchema, async (input) => {
      try {
        const db = requireDatabase()
        taskQueries.reorderTasks(db, input.taskIds, input.positions)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to reorder tasks'
        return { success: false, error: message }
      }
    })
  )

  // tasks:duplicate - Duplicate a task (including subtasks)
  ipcMain.handle(
    TasksChannels.invoke.DUPLICATE,
    createStringHandler(async (id) => {
      try {
        const db = requireDatabase()
        const newId = generateId()
        const task = taskQueries.duplicateTask(db, id, newId)

        if (!task) {
          return { success: false, task: null, error: 'Task not found' }
        }

        // Copy tags
        const tags = taskQueries.getTaskTags(db, id)
        if (tags.length > 0) {
          taskQueries.setTaskTags(db, newId, tags)
        }

        // Copy linked notes
        const linkedNoteIds = taskQueries.getTaskNoteIds(db, id)
        if (linkedNoteIds.length > 0) {
          taskQueries.setTaskNotes(db, newId, linkedNoteIds)
        }

        const enrichedTask = {
          ...task,
          linkedNoteIds
        }

        // IMPORTANT: Emit parent task FIRST so it exists in state when subtasks arrive
        emitTaskEvent(TasksChannels.events.CREATED, { task: enrichedTask })
        syncTaskCreate(db, newId)

        // Duplicate subtasks (if any)
        const subtasks = taskQueries.getSubtasks(db, id)

        for (const subtask of subtasks) {
          const newSubtaskId = generateId()
          // Use duplicateSubtask which sets parentId correctly and keeps original title
          const duplicatedSubtask = taskQueries.duplicateSubtask(
            db,
            subtask.id,
            newSubtaskId,
            newId
          )

          if (duplicatedSubtask) {
            // Copy subtask tags
            const subtaskTags = taskQueries.getTaskTags(db, subtask.id)
            if (subtaskTags.length > 0) {
              taskQueries.setTaskTags(db, newSubtaskId, subtaskTags)
            }

            // Copy subtask linked notes
            const subtaskNoteIds = taskQueries.getTaskNoteIds(db, subtask.id)
            if (subtaskNoteIds.length > 0) {
              taskQueries.setTaskNotes(db, newSubtaskId, subtaskNoteIds)
            }

            emitTaskEvent(TasksChannels.events.CREATED, {
              task: { ...duplicatedSubtask, linkedNoteIds: subtaskNoteIds }
            })
            syncTaskCreate(db, newSubtaskId)
          }
        }

        return { success: true, task: enrichedTask }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to duplicate task'
        return { success: false, task: null, error: message }
      }
    })
  )

  // ============================================================================
  // Subtask Operations
  // ============================================================================

  // tasks:get-subtasks - Get subtasks of a task
  ipcMain.handle(
    TasksChannels.invoke.GET_SUBTASKS,
    createStringHandler(async (parentId) => {
      const db = requireDatabase()
      return taskQueries.getSubtasks(db, parentId)
    })
  )

  // tasks:convert-to-subtask - Convert a task to a subtask
  ipcMain.handle(
    TasksChannels.invoke.CONVERT_TO_SUBTASK,
    createValidatedHandler(ConvertToSubtaskSchema, async (input) => {
      try {
        const db = requireDatabase()
        const task = taskQueries.moveTask(db, input.taskId, { parentId: input.parentId })
        if (!task) {
          return { success: false, task: null, error: 'Task not found' }
        }
        const enrichedTask = {
          ...task,
          linkedNoteIds: taskQueries.getTaskNoteIds(db, input.taskId)
        }
        syncTaskUpdate(db, input.taskId, ['parentId'])
        return { success: true, task: enrichedTask }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to convert to subtask'
        return { success: false, task: null, error: message }
      }
    })
  )

  // tasks:convert-to-task - Convert a subtask to a top-level task
  ipcMain.handle(
    TasksChannels.invoke.CONVERT_TO_TASK,
    createStringHandler(async (taskId) => {
      try {
        const db = requireDatabase()
        const task = taskQueries.moveTask(db, taskId, { parentId: null })
        if (!task) {
          return { success: false, task: null, error: 'Task not found' }
        }
        const enrichedTask = {
          ...task,
          linkedNoteIds: taskQueries.getTaskNoteIds(db, taskId)
        }
        syncTaskUpdate(db, taskId, ['parentId'])
        return { success: true, task: enrichedTask }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to convert to task'
        return { success: false, task: null, error: message }
      }
    })
  )

  // ============================================================================
  // Project Operations
  // ============================================================================

  // tasks:project-create - Create a new project
  ipcMain.handle(
    TasksChannels.invoke.PROJECT_CREATE,
    createValidatedHandler(ProjectCreateSchema, async (input) => {
      try {
        const db = requireDatabase()
        const id = generateId()
        const position = projectQueries.getNextProjectPosition(db)

        const project = projectQueries.insertProject(db, {
          id,
          name: input.name,
          description: input.description ?? null,
          color: input.color ?? '#6366f1',
          icon: input.icon ?? null,
          position,
          isInbox: false
        })

        if (input.statuses && input.statuses.length >= 2) {
          projectQueries.createCustomStatuses(db, id, input.statuses)
        } else {
          projectQueries.createDefaultStatuses(db, id)
        }

        const fullProject = projectQueries.getProjectWithStatuses(db, id)
        emitTaskEvent(TasksChannels.events.PROJECT_CREATED, { project: fullProject ?? project })
        syncProjectCreate(db, id)

        return { success: true, project: fullProject ?? project }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create project'
        return { success: false, project: null, error: message }
      }
    })
  )

  // tasks:project-get - Get a project by ID
  ipcMain.handle(
    TasksChannels.invoke.PROJECT_GET,
    createStringHandler(async (id) => {
      const db = requireDatabase()
      return projectQueries.getProjectWithStatuses(db, id)
    })
  )

  // tasks:project-update - Update a project
  ipcMain.handle(
    TasksChannels.invoke.PROJECT_UPDATE,
    createValidatedHandler(ProjectUpdateSchema, async (input) => {
      try {
        const db = requireDatabase()
        const { id, statuses: statusUpdates, ...metadataUpdates } = input
        const project = projectQueries.updateProject(db, id, metadataUpdates)

        if (!project) {
          return { success: false, project: null, error: 'Project not found' }
        }

        if (statusUpdates) {
          projectQueries.reconcileProjectStatuses(db, id, statusUpdates)
        }

        const fullProject = projectQueries.getProjectWithStatuses(db, id)
        emitTaskEvent(TasksChannels.events.PROJECT_UPDATED, { id, project: fullProject ?? project })
        syncProjectUpdate(db, id)

        return { success: true, project: fullProject ?? project }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to update project'
        return { success: false, project: null, error: message }
      }
    })
  )

  // tasks:project-delete - Delete a project
  ipcMain.handle(
    TasksChannels.invoke.PROJECT_DELETE,
    createStringHandler(async (id) => {
      try {
        const db = requireDatabase()
        const syncService = getProjectSyncService()
        let snapshot: string | undefined
        if (syncService) {
          const project = projectQueries.getProjectWithStatuses(db, id)
          if (project) snapshot = JSON.stringify(project)
        }
        projectQueries.deleteProject(db, id)
        emitTaskEvent(TasksChannels.events.PROJECT_DELETED, { id })
        if (syncService && snapshot) syncService.enqueueDelete(id, snapshot)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete project'
        return { success: false, error: message }
      }
    })
  )

  // tasks:project-list - List all projects
  ipcMain.handle(
    TasksChannels.invoke.PROJECT_LIST,
    createHandler(async () => {
      const db = requireDatabase()
      const projects = projectQueries.getProjectsWithStats(db)
      return { projects }
    })
  )

  // tasks:project-archive - Archive a project
  ipcMain.handle(
    TasksChannels.invoke.PROJECT_ARCHIVE,
    createStringHandler(async (id) => {
      try {
        const db = requireDatabase()
        projectQueries.archiveProject(db, id)
        syncProjectUpdate(db, id)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to archive project'
        return { success: false, error: message }
      }
    })
  )

  // tasks:project-reorder - Reorder projects
  ipcMain.handle(
    TasksChannels.invoke.PROJECT_REORDER,
    createValidatedHandler(ProjectReorderSchema, async (input) => {
      try {
        const db = requireDatabase()
        projectQueries.reorderProjects(db, input.projectIds, input.positions)
        for (const pid of input.projectIds) {
          syncProjectUpdate(db, pid, ['position'])
        }
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to reorder projects'
        return { success: false, error: message }
      }
    })
  )

  // ============================================================================
  // Status Operations
  // ============================================================================

  // tasks:status-create - Create a new status
  ipcMain.handle(
    TasksChannels.invoke.STATUS_CREATE,
    createValidatedHandler(StatusCreateSchema, async (input) => {
      try {
        const db = requireDatabase()
        const id = generateId()
        const position = projectQueries.getNextStatusPosition(db, input.projectId)

        const status = projectQueries.insertStatus(db, {
          id,
          projectId: input.projectId,
          name: input.name,
          color: input.color ?? '#6b7280',
          position,
          isDefault: false,
          isDone: input.isDone ?? false
        })

        syncProjectUpdate(db, input.projectId)
        return { success: true, status }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create status'
        return { success: false, status: null, error: message }
      }
    })
  )

  // tasks:status-update - Update a status
  ipcMain.handle(
    TasksChannels.invoke.STATUS_UPDATE,
    createValidatedHandler(StatusUpdateSchema, async (input) => {
      try {
        const db = requireDatabase()
        const { id, ...updates } = input
        const status = projectQueries.updateStatus(db, id, updates)
        if (!status) {
          return { success: false, error: 'Status not found' }
        }
        const resolved = projectQueries.getStatusById(db, id)
        if (resolved) syncProjectUpdate(db, resolved.projectId)
        return { success: true, status }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to update status'
        return { success: false, error: message }
      }
    })
  )

  // tasks:status-delete - Delete a status
  ipcMain.handle(
    TasksChannels.invoke.STATUS_DELETE,
    createStringHandler(async (id) => {
      try {
        const db = requireDatabase()
        const statusBefore = projectQueries.getStatusById(db, id)
        projectQueries.deleteStatus(db, id)
        if (statusBefore) syncProjectUpdate(db, statusBefore.projectId)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete status'
        return { success: false, error: message }
      }
    })
  )

  // tasks:status-reorder - Reorder statuses
  ipcMain.handle(
    TasksChannels.invoke.STATUS_REORDER,
    createValidatedHandler(StatusReorderSchema, async (input) => {
      try {
        const db = requireDatabase()
        projectQueries.reorderStatuses(db, input.statusIds, input.positions)
        if (input.statusIds.length > 0) {
          const firstStatus = projectQueries.getStatusById(db, input.statusIds[0])
          if (firstStatus) syncProjectUpdate(db, firstStatus.projectId)
        }
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to reorder statuses'
        return { success: false, error: message }
      }
    })
  )

  // tasks:status-list - List statuses for a project
  ipcMain.handle(
    TasksChannels.invoke.STATUS_LIST,
    createStringHandler(async (projectId) => {
      const db = requireDatabase()
      return projectQueries.getStatusesByProject(db, projectId)
    })
  )

  // ============================================================================
  // Tag Operations
  // ============================================================================

  // tasks:get-tags - Get all task tags with counts
  ipcMain.handle(
    TasksChannels.invoke.GET_TAGS,
    createHandler(async () => {
      const db = requireDatabase()
      return taskQueries.getAllTaskTags(db)
    })
  )

  // ============================================================================
  // Bulk Operations
  // ============================================================================

  // tasks:bulk-complete - Complete multiple tasks
  ipcMain.handle(
    TasksChannels.invoke.BULK_COMPLETE,
    createValidatedHandler(BulkIdsSchema, async (input) => {
      try {
        const db = requireDatabase()
        const count = taskQueries.bulkCompleteTasks(db, input.ids)

        for (const id of input.ids) {
          const task = taskQueries.getTaskById(db, id)
          if (task) {
            const enrichedTask = {
              ...task,
              linkedNoteIds: taskQueries.getTaskNoteIds(db, id)
            }
            emitTaskEvent(TasksChannels.events.COMPLETED, { id, task: enrichedTask })
            syncTaskUpdate(db, id, ['completedAt'])
          }
        }

        return { success: true, count }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to complete tasks'
        return { success: false, count: 0, error: message }
      }
    })
  )

  // tasks:bulk-delete - Delete multiple tasks
  ipcMain.handle(
    TasksChannels.invoke.BULK_DELETE,
    createValidatedHandler(BulkIdsSchema, async (input) => {
      try {
        const db = requireDatabase()
        const syncService = getTaskSyncService()
        if (syncService) {
          for (const id of input.ids) {
            const task = taskQueries.getTaskById(db, id)
            if (task) syncService.enqueueDelete(id, JSON.stringify(task))
          }
        }
        const count = taskQueries.bulkDeleteTasks(db, input.ids)
        input.ids.forEach((id) => emitTaskEvent(TasksChannels.events.DELETED, { id }))
        return { success: true, count }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete tasks'
        return { success: false, count: 0, error: message }
      }
    })
  )

  // tasks:bulk-move - Move multiple tasks to a project
  ipcMain.handle(
    TasksChannels.invoke.BULK_MOVE,
    createValidatedHandler(BulkMoveSchema, async (input) => {
      try {
        const db = requireDatabase()
        const count = taskQueries.bulkMoveTasks(db, input.ids, input.projectId)

        for (const id of input.ids) {
          const task = taskQueries.getTaskById(db, id)
          if (task) {
            const enrichedTask = {
              ...task,
              linkedNoteIds: taskQueries.getTaskNoteIds(db, id)
            }
            emitTaskEvent(TasksChannels.events.UPDATED, {
              id,
              task: enrichedTask,
              changes: { projectId: input.projectId }
            })
            syncTaskUpdate(db, id, ['projectId', 'position'])
          }
        }

        return { success: true, count }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to move tasks'
        return { success: false, count: 0, error: message }
      }
    })
  )

  // tasks:bulk-archive - Archive multiple tasks
  ipcMain.handle(
    TasksChannels.invoke.BULK_ARCHIVE,
    createValidatedHandler(BulkIdsSchema, async (input) => {
      try {
        const db = requireDatabase()
        const count = taskQueries.bulkArchiveTasks(db, input.ids)

        for (const id of input.ids) {
          const task = taskQueries.getTaskById(db, id)
          if (task) {
            const enrichedTask = {
              ...task,
              linkedNoteIds: taskQueries.getTaskNoteIds(db, id)
            }
            emitTaskEvent(TasksChannels.events.UPDATED, {
              id,
              task: enrichedTask,
              changes: { archivedAt: task.archivedAt }
            })
            syncTaskUpdate(db, id, ['archivedAt'])
          }
        }

        return { success: true, count }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to archive tasks'
        return { success: false, count: 0, error: message }
      }
    })
  )

  // ============================================================================
  // Stats and Views
  // ============================================================================

  // tasks:get-stats - Get task statistics
  ipcMain.handle(
    TasksChannels.invoke.GET_STATS,
    createHandler(async () => {
      const db = requireDatabase()
      return taskQueries.getTaskStats(db)
    })
  )

  // tasks:get-today - Get today's tasks
  ipcMain.handle(
    TasksChannels.invoke.GET_TODAY,
    createHandler(async () => {
      const db = requireDatabase()
      const tasks = taskQueries.getTodayTasks(db)
      // Enrich with linked note IDs
      const enrichedTasks = tasks.map((task) => ({
        ...task,
        linkedNoteIds: taskQueries.getTaskNoteIds(db, task.id)
      }))
      return { tasks: enrichedTasks, total: tasks.length, hasMore: false }
    })
  )

  // tasks:get-upcoming - Get upcoming tasks
  ipcMain.handle(
    TasksChannels.invoke.GET_UPCOMING,
    createValidatedHandler(GetUpcomingSchema, async (input) => {
      const db = requireDatabase()
      const tasks = taskQueries.getUpcomingTasks(db, input.days)
      // Enrich with linked note IDs
      const enrichedTasks = tasks.map((task) => ({
        ...task,
        linkedNoteIds: taskQueries.getTaskNoteIds(db, task.id)
      }))
      return { tasks: enrichedTasks, total: tasks.length, hasMore: false }
    })
  )

  // tasks:get-overdue - Get overdue tasks
  ipcMain.handle(
    TasksChannels.invoke.GET_OVERDUE,
    createHandler(async () => {
      const db = requireDatabase()
      const tasks = taskQueries.getOverdueTasks(db)
      // Enrich with linked note IDs
      const enrichedTasks = tasks.map((task) => ({
        ...task,
        linkedNoteIds: taskQueries.getTaskNoteIds(db, task.id)
      }))
      return { tasks: enrichedTasks, total: tasks.length, hasMore: false }
    })
  )

  // tasks:get-linked-tasks - Get tasks linked to a specific note
  ipcMain.handle(
    TasksChannels.invoke.GET_LINKED_TASKS,
    createStringHandler(async (noteId) => {
      const db = requireDatabase()
      const tasks = taskQueries.getTasksLinkedToNote(db, noteId)
      // Enrich with tags and linked note IDs
      return tasks.map((task) => ({
        ...task,
        tags: taskQueries.getTaskTags(db, task.id),
        linkedNoteIds: taskQueries.getTaskNoteIds(db, task.id)
      }))
    })
  )

  // Development helpers used by renderer task tooling.
  ipcMain.handle('tasks:seed-performance-test', createHandler(() => ({ success: true, message: '' })))
  ipcMain.handle('tasks:seed-demo', createHandler(() => ({ success: true, message: '' })))

  logger.info('Tasks handlers registered')
}

/**
 * Unregister all task-related IPC handlers.
 * Useful for cleanup or testing.
 */
export function unregisterTasksHandlers(): void {
  Object.values(TasksChannels.invoke).forEach((channel) => {
    ipcMain.removeHandler(channel)
  })
  ipcMain.removeHandler('tasks:seed-performance-test')
  ipcMain.removeHandler('tasks:seed-demo')
  logger.info('Tasks handlers unregistered')
}
