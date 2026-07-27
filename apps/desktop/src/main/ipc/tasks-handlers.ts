import { ipcMain } from 'electron'
import { TasksChannels } from '@memry/contracts/ipc-channels'
import {
  BulkIdsSchema,
  BulkMoveSchema,
  ConvertToSubtaskSchema,
  GetUpcomingSchema,
  ProjectCreateSchema,
  ProjectLinkItemSchema,
  ProjectListForItemSchema,
  ProjectReorderSchema,
  ProjectSetHomeNoteSchema,
  ProjectSetLinkPinnedSchema,
  ProjectCaptureUrlSchema,
  ProjectImportFilesSchema,
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
import { captureUrlToProject } from '../tasks/capture-url'
import { importFilesToProject } from '../tasks/import-files-to-project'
import { createNote, importFiles, getNoteByPath } from '../vault/notes-crud'
import { fetchUrlMetadata } from '../inbox/metadata'
import { createTasksPublisher } from '../tasks/publisher'
import { trackMainEvent } from '../telemetry/track'

const logger = createLogger('IPC:Tasks')

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
      withDb(async (db, id) => {
        const result = await createTaskDomain(db).uncompleteTask(id)
        trackMainEvent('task_reopened', {
          surface: 'tasks',
          action: 'reopened',
          objectType: 'task',
          result: 'success'
        })
        return result
      }, 'Failed to uncomplete task')
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
    TasksChannels.invoke.PROJECT_LINK_ITEM,
    createValidatedHandler(
      ProjectLinkItemSchema,
      withDb((db, input) => createTaskDomain(db).linkItemToProject(input), 'Failed to link item')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_UNLINK_ITEM,
    createValidatedHandler(
      ProjectLinkItemSchema,
      withDb(
        (db, input) => createTaskDomain(db).unlinkItemFromProject(input),
        'Failed to unlink item'
      )
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_LIST_LINKS,
    createStringHandler(async (id) => createTaskDomain(requireDatabase()).listProjectLinks(id))
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_CAPTURE_URL,
    createValidatedHandler(
      ProjectCaptureUrlSchema,
      withDb(async (db, input) => {
        const domain = createTaskDomain(db)
        return captureUrlToProject(
          {
            fetchTitle: async (url) => (await fetchUrlMetadata(url)).title ?? null,
            createNote: async ({ title, content }) => createNote({ title, content }),
            linkToProject: (projectId, noteId) => {
              void domain.linkItemToProject({ projectId, itemType: 'note', itemId: noteId })
            }
          },
          input
        )
      }, 'Failed to capture link')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_IMPORT_FILES,
    createValidatedHandler(
      ProjectImportFilesSchema,
      withDb(async (db, input) => {
        const domain = createTaskDomain(db)
        return importFilesToProject(
          {
            importFiles: async (sourcePaths) => {
              const result = await importFiles({ sourcePaths })
              return { importedFiles: result.importedFiles, errors: result.errors }
            },
            getIdByPath: async (destPath) => (await getNoteByPath(destPath))?.id ?? null,
            linkToProject: (projectId, fileId) => {
              void domain.linkItemToProject({ projectId, itemType: 'file', itemId: fileId })
            },
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
          },
          input
        )
      }, 'Failed to import files')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_LIST_CONTENTS,
    createStringHandler(async (id) => createTaskDomain(requireDatabase()).listProjectContents(id))
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_SET_LINK_PINNED,
    createValidatedHandler(
      ProjectSetLinkPinnedSchema,
      withDb(
        (db, input) => createTaskDomain(db).setProjectLinkPinned(input),
        'Failed to update pinned state'
      )
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_SET_HOME_NOTE,
    createValidatedHandler(
      ProjectSetHomeNoteSchema,
      withDb(
        (db, input) => createTaskDomain(db).setProjectHomeNote(input),
        'Failed to set home note'
      )
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_LIST_FOR_ITEM,
    createValidatedHandler(
      ProjectListForItemSchema,
      withDb(
        (db, input) => createTaskDomain(db).listForItem(input.itemType, input.itemId),
        'Failed to list projects for item'
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
}

export function unregisterTasksHandlers(): void {
  Object.values(TasksChannels.invoke).forEach((channel) => {
    ipcMain.removeHandler(channel)
  })
  logger.info('Tasks handlers unregistered')
}
