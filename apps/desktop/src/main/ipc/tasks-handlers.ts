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
import { linkProjectItem, unlinkProjectItem } from '../tasks/project-item-links'
import {
  captureProjectName,
  captureProjectForDelete,
  propagateProjectRename,
  propagateProjectDelete
} from '../tasks/project-name-propagation'
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
      withDb((db, input) => createTaskDomain(db).createTask(input), 'errors:task.createFailed')
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
      withDb((db, input) => createTaskDomain(db).updateTask(input), 'errors:task.updateFailed')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.DELETE,
    createStringHandler(
      withDb((db, id) => createTaskDomain(db).deleteTask(id), 'errors:task.deleteFailed')
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
      withDb((db, input) => createTaskDomain(db).completeTask(input), 'errors:task.completeFailed')
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
      }, 'errors:task.uncompleteFailed')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.ARCHIVE,
    createStringHandler(
      withDb((db, id) => createTaskDomain(db).archiveTask(id), 'errors:task.archiveFailed')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.UNARCHIVE,
    createStringHandler(
      withDb((db, id) => createTaskDomain(db).unarchiveTask(id), 'errors:task.unarchiveFailed')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.MOVE,
    createValidatedHandler(
      TaskMoveSchema,
      withDb((db, input) => createTaskDomain(db).moveTask(input), 'errors:task.moveFailed')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.REORDER,
    createValidatedHandler(
      TaskReorderSchema,
      withDb(
        (db, input) => createTaskDomain(db).reorderTasks(input.taskIds, input.positions),
        'errors:task.reorderFailed'
      )
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.DUPLICATE,
    createStringHandler(
      withDb((db, id) => createTaskDomain(db).duplicateTask(id), 'errors:task.duplicateFailed')
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
        'errors:task.convertToSubtaskFailed'
      )
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.CONVERT_TO_TASK,
    createStringHandler(
      withDb((db, id) => createTaskDomain(db).convertToTask(id), 'errors:task.convertToTaskFailed')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_CREATE,
    createValidatedHandler(
      ProjectCreateSchema,
      withDb(
        (db, input) => createTaskDomain(db).createProject(input),
        'errors:project.createFailed'
      )
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
      withDb(async (db, input) => {
        // Read the previous name before the domain call overwrites it — a
        // rename that is not propagated leaves linked notes' frontmatter
        // naming a project that no longer matches.
        const previousName = captureProjectName(db, input.id)
        const result = await createTaskDomain(db).updateProject(input)
        if (
          result.success &&
          previousName !== undefined &&
          input.name !== undefined &&
          input.name !== previousName
        ) {
          await propagateProjectRename(db, input.id, previousName, input.name)
        }
        return result
      }, 'errors:project.updateFailed')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_DELETE,
    createStringHandler(
      withDb(async (db, id) => {
        // Collect the linked notes and the project's name before the domain
        // call — project_links cascades away with the project, so after the
        // delete there is nothing left to look up.
        const capture = captureProjectForDelete(db, id)
        const result = await createTaskDomain(db).deleteProject(id)
        if (result.success && capture) {
          await propagateProjectDelete(db, id, capture.name, capture.noteIds)
        }
        return result
      }, 'errors:project.deleteFailed')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_LIST,
    createHandler(async () => createTaskDomain(requireDatabase()).listProjects())
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_ARCHIVE,
    createStringHandler(
      withDb((db, id) => createTaskDomain(db).archiveProject(id), 'errors:project.archiveFailed')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_REORDER,
    createValidatedHandler(
      ProjectReorderSchema,
      withDb(
        (db, input) => createTaskDomain(db).reorderProjects(input.projectIds, input.positions),
        'errors:project.reorderFailed'
      )
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_LINK_ITEM,
    createValidatedHandler(
      ProjectLinkItemSchema,
      withDb(async (db, input) => {
        const result = await linkProjectItem(db, createTaskDomain(db), input)
        if (result.success) {
          trackMainEvent('project_item_linked', {
            surface: 'tasks',
            action: 'link_item',
            // Schema-constrained enum ('note' | 'file' | 'calendar_event'), never a name.
            objectType: input.itemType,
            result: 'success'
          })
        }
        return result
      }, 'errors:project.linkItemFailed')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_UNLINK_ITEM,
    createValidatedHandler(
      ProjectLinkItemSchema,
      withDb(
        (db, input) => unlinkProjectItem(db, createTaskDomain(db), input),
        'errors:project.unlinkItemFailed'
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
        const result = await captureUrlToProject(
          {
            fetchTitle: async (url) => (await fetchUrlMetadata(url)).title ?? null,
            createNote: async ({ title, content }) => createNote({ title, content }),
            linkToProject: async (projectId, noteId) => {
              const linked = await linkProjectItem(db, domain, {
                projectId,
                itemType: 'note',
                itemId: noteId
              })
              if (!linked.success) throw new Error(linked.error ?? 'Failed to link note')
            }
          },
          input
        )
        if (result.success) {
          trackMainEvent('project_item_linked', {
            surface: 'tasks',
            action: 'capture_url',
            objectType: 'url',
            result: 'success'
          })
        }
        return result
      }, 'errors:project.captureLinkFailed')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_IMPORT_FILES,
    createValidatedHandler(
      ProjectImportFilesSchema,
      withDb(async (db, input) => {
        const domain = createTaskDomain(db)
        const result = await importFilesToProject(
          {
            importFiles: async (sourcePaths) => {
              const result = await importFiles({ sourcePaths })
              return { importedFiles: result.importedFiles, errors: result.errors }
            },
            getIdByPath: async (destPath) => (await getNoteByPath(destPath))?.id ?? null,
            linkToProject: async (projectId, fileId) => {
              const linked = await linkProjectItem(db, domain, {
                projectId,
                itemType: 'file',
                itemId: fileId
              })
              if (!linked.success) throw new Error(linked.error ?? 'Failed to link file')
            },
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
          },
          input
        )
        if (result.linked.length > 0) {
          trackMainEvent('project_item_linked', {
            surface: 'tasks',
            action: 'import_files',
            objectType: 'file',
            result: 'success',
            metrics: { itemCount: result.linked.length }
          })
        }
        return result
      }, 'errors:project.importFilesFailed')
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
        'errors:project.updatePinnedFailed'
      )
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_SET_HOME_NOTE,
    createValidatedHandler(
      ProjectSetHomeNoteSchema,
      withDb(async (db, input) => {
        const result = await createTaskDomain(db).setProjectHomeNote(input)
        if (result.success) {
          trackMainEvent('project_updated', {
            surface: 'tasks',
            action: 'set_home_note',
            objectType: 'project',
            result: 'success'
          })
        }
        return result
      }, 'errors:project.setHomeNoteFailed')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.PROJECT_LIST_FOR_ITEM,
    createValidatedHandler(
      ProjectListForItemSchema,
      withDb(
        (db, input) => createTaskDomain(db).listForItem(input.itemType, input.itemId),
        'errors:project.listForItemFailed'
      )
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.STATUS_CREATE,
    createValidatedHandler(
      StatusCreateSchema,
      withDb(
        (db, input) => createTaskDomain(db).createStatus(input),
        'errors:taskStatus.createFailed'
      )
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.STATUS_UPDATE,
    createValidatedHandler(
      StatusUpdateSchema,
      withDb(
        (db, input) => createTaskDomain(db).updateStatus(input),
        'errors:taskStatus.updateFailed'
      )
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.STATUS_DELETE,
    createStringHandler(
      withDb((db, id) => createTaskDomain(db).deleteStatus(id), 'errors:taskStatus.deleteFailed')
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.STATUS_REORDER,
    createValidatedHandler(
      StatusReorderSchema,
      withDb(
        (db, input) => createTaskDomain(db).reorderStatuses(input.statusIds, input.positions),
        'errors:taskStatus.reorderFailed'
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
        'errors:task.completeManyFailed'
      )
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.BULK_DELETE,
    createValidatedHandler(
      BulkIdsSchema,
      withDb(
        (db, input) => createTaskDomain(db).bulkDelete(input.ids),
        'errors:task.deleteManyFailed'
      )
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.BULK_MOVE,
    createValidatedHandler(
      BulkMoveSchema,
      withDb(
        (db, input) => createTaskDomain(db).bulkMove(input.ids, input.projectId),
        'errors:task.moveManyFailed'
      )
    )
  )

  ipcMain.handle(
    TasksChannels.invoke.BULK_ARCHIVE,
    createValidatedHandler(
      BulkIdsSchema,
      withDb(
        (db, input) => createTaskDomain(db).bulkArchive(input.ids),
        'errors:task.archiveManyFailed'
      )
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
