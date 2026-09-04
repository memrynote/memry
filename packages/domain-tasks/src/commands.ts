import type {
  Project,
  ProjectLink,
  ProjectLinkItemInput,
  ProjectSetHomeNoteInput,
  ProjectSetLinkPinnedInput,
  ProjectWithStatuses,
  Status,
  Task
} from './types.ts'
import type { TasksQueryRepository } from './queries.ts'

export interface StatusDefinitionInput {
  id?: string
  name: string
  color: string
  type: 'todo' | 'in_progress' | 'done'
  order: number
}

export interface TaskCreateInput {
  projectId: string
  title: string
  description?: string | null
  priority?: number
  statusId?: string | null
  parentId?: string | null
  dueDate?: string | null
  dueTime?: string | null
  startDate?: string | null
  repeatConfig?: Task['repeatConfig']
  repeatFrom?: Task['repeatFrom']
  tags?: string[]
  linkedNoteIds?: string[]
  linkedCanvasIds?: string[]
  sourceNoteId?: string | null
  position?: number
}

export interface TaskUpdateInput {
  id: string
  title?: string
  description?: string | null
  priority?: number
  projectId?: string
  statusId?: string | null
  parentId?: string | null
  dueDate?: string | null
  dueTime?: string | null
  startDate?: string | null
  repeatConfig?: Task['repeatConfig']
  repeatFrom?: Task['repeatFrom']
  tags?: string[]
  linkedNoteIds?: string[]
  linkedCanvasIds?: string[]
}

export interface TaskMoveInput {
  taskId: string
  targetProjectId?: string
  targetStatusId?: string | null
  targetParentId?: string | null
  position: number
}

export interface TaskCompleteInput {
  id: string
  completedAt?: string
}

export interface ProjectCreateInput {
  name: string
  description?: string | null
  color?: string
  icon?: string | null
  statuses?: StatusDefinitionInput[]
}

export interface ProjectUpdateInput {
  id: string
  name?: string
  description?: string | null
  color?: string
  icon?: string | null
  statuses?: StatusDefinitionInput[]
}

export interface StatusCreateInput {
  projectId: string
  name: string
  color?: string
  isDone?: boolean
}

export interface StatusUpdateInput {
  id: string
  name?: string
  color?: string
  position?: number
  isDefault?: boolean
  isDone?: boolean
}

export interface TasksCommandRepository extends TasksQueryRepository {
  createTask(
    task: Omit<
      Task,
      | 'tags'
      | 'linkedNoteIds'
      | 'linkedCanvasIds'
      | 'hasSubtasks'
      | 'subtaskCount'
      | 'completedSubtaskCount'
    >
  ): Task
  updateTask(
    id: string,
    updates: Partial<
      Omit<
        Task,
        | 'id'
        | 'createdAt'
        | 'modifiedAt'
        | 'tags'
        | 'linkedNoteIds'
        | 'linkedCanvasIds'
        | 'hasSubtasks'
        | 'subtaskCount'
        | 'completedSubtaskCount'
      >
    >
  ): Task | undefined
  deleteTask(id: string): void
  completeTask(id: string, completedAt?: string): Task | undefined
  uncompleteTask(id: string): Task | undefined
  archiveTask(id: string): Task | undefined
  unarchiveTask(id: string): Task | undefined
  moveTask(
    id: string,
    updates: {
      projectId?: string
      statusId?: string | null
      parentId?: string | null
      position?: number
    }
  ): Task | undefined
  reorderTasks(taskIds: string[], positions: number[]): void
  duplicateTask(id: string, newId: string): Task | undefined
  duplicateSubtask(id: string, newId: string, newParentId: string): Task | undefined
  getTaskTags(taskId: string): string[]
  setTaskTags(taskId: string, tags: string[]): void
  getTaskNoteIds(taskId: string): string[]
  setTaskNotes(taskId: string, noteIds: string[]): void
  getTaskCanvasIds(taskId: string): string[]
  setTaskCanvases(taskId: string, canvasIds: string[]): void
  getNextTaskPosition(projectId: string, parentId?: string | null): number
  getStatus(id: string): Status | undefined
  getEquivalentStatus(targetProjectId: string, sourceStatus?: Status): Status | undefined
  createProject(project: Omit<Project, 'createdAt' | 'modifiedAt' | 'archivedAt'>): Project
  updateProject(
    id: string,
    updates: Partial<Omit<Project, 'id' | 'createdAt' | 'modifiedAt'>>
  ): Project | undefined
  deleteProject(id: string): void
  archiveProject(id: string): Project | undefined
  reorderProjects(projectIds: string[], positions: number[]): void
  getNextProjectPosition(): number
  createDefaultStatuses(projectId: string): Status[]
  createCustomStatuses(projectId: string, statuses: StatusDefinitionInput[]): Status[]
  reconcileProjectStatuses(projectId: string, statuses: StatusDefinitionInput[]): void
  linkItemToProject(link: {
    id: string
    projectId: string
    itemType: string
    itemId: string
  }): ProjectLink
  unlinkItemFromProject(projectId: string, itemType: string, itemId: string): void
  findProjectLink(projectId: string, itemType: string, itemId: string): ProjectLink | undefined
  setProjectHomeNote(projectId: string, noteId: string | null): void
  setProjectLinkPinned(projectId: string, itemId: string, pinned: boolean): void
  deleteProjectLinksForItem(itemType: string, itemId: string): string[]
  clearProjectsHomeNote(noteId: string): string[]
  createStatus(status: Omit<Status, 'createdAt'>): Status
  updateStatus(
    id: string,
    updates: Partial<Omit<Status, 'id' | 'projectId' | 'createdAt'>>
  ): Status | undefined
  deleteStatus(id: string): void
  reorderStatuses(statusIds: string[], positions: number[]): void
  getNextStatusPosition(projectId: string): number
  bulkCompleteTasks(ids: string[]): number
  bulkDeleteTasks(ids: string[]): number
  bulkMoveTasks(ids: string[], projectId: string): number
  bulkArchiveTasks(ids: string[]): number
}

/**
 * `previous` carries the pre-write value of every field named in
 * `changedFields`, so a subscriber can render old → new without re-reading the
 * row (by then it is gone). Optional because subscribers must tolerate a
 * producer that cannot supply it; every call site in this file does.
 *
 * `previous.description` is present when the body changed. It stays in memory
 * only: the one subscriber that reads it (the task activity log) needs the old
 * length to compute a delta, and stores that delta rather than the body. The
 * event already carries the new body on `task`, so carrying the old one costs
 * nothing extra.
 */
export interface TaskUpdatedEvent {
  id: string
  task: Task
  changes: Partial<Task>
  changedFields: string[]
  previous?: Partial<Task>
}

export interface TaskMovedEvent {
  id: string
  task: Task
  changedFields: string[]
  previous?: Partial<Task>
}

export interface TaskCompletedEvent {
  id: string
  task: Task
  previous?: Partial<Task>
}

export interface ProjectUpdatedEvent {
  id: string
  project: ProjectWithStatuses | Project
  changedFields?: string[]
}

export interface StatusEvent {
  status: Status
}

export interface StatusDeletedEvent {
  id: string
  projectId: string
}

export interface TasksDomainPublisher {
  taskCreated(event: { task: Task }): void | Promise<void>
  taskUpdated(event: TaskUpdatedEvent): void | Promise<void>
  taskDeleted(event: { id: string; snapshot?: Task }): void | Promise<void>
  taskCompleted(event: TaskCompletedEvent): void | Promise<void>
  taskMoved(event: TaskMovedEvent): void | Promise<void>
  taskReordered?(event: { id: string; changedFields: string[] }): void | Promise<void>
  projectCreated(event: { project: ProjectWithStatuses | Project }): void | Promise<void>
  projectUpdated(event: ProjectUpdatedEvent): void | Promise<void>
  projectDeleted(event: { id: string; snapshot?: ProjectWithStatuses }): void | Promise<void>
  statusCreated(event: StatusEvent): void | Promise<void>
  statusUpdated(event: StatusEvent): void | Promise<void>
  statusDeleted(event: StatusDeletedEvent): void | Promise<void>
}

export interface CreateTasksCommandsDeps {
  repository: TasksCommandRepository
  publisher: TasksDomainPublisher
  generateId: () => string
}

/**
 * Drops keys whose value is `undefined`.
 *
 * Callers do not send only what the user touched. The tasks page builds one
 * fixed key set on every edit — title, description, priority, projectId,
 * statusId, dueDate, dueTime, isRepeating, repeatConfig, tags, linkedNoteIds —
 * and leaves the untouched ones `undefined`, so the raw input says nothing
 * about what changed. The write layer already ignores them (drizzle omits
 * `undefined` from `.set()`), so treating them as changes only misreports: a
 * status-only edit would log every other field as cleared in the activity feed
 * and bump the sync field clock of each, letting this device win a merge on
 * fields it never edited.
 *
 * `null` is untouched — it still means "clear this field".
 */
function definedUpdates(updates: Partial<Task>): Partial<Task> {
  return Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined)
  ) as Partial<Task>
}

function computeChangedFields(
  existingTask: Task | undefined,
  updates: Partial<Task>,
  relationChanges: Array<{ field: keyof Task; before: unknown; after: unknown }> = []
): string[] {
  const changedFields = new Set<string>()

  if (!existingTask) {
    for (const key of Object.keys(updates)) {
      changedFields.add(key)
    }
  } else {
    for (const [key, value] of Object.entries(updates)) {
      const previous = existingTask[key as keyof Task] ?? null
      const next = value ?? null
      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        changedFields.add(key)
      }
    }
  }

  for (const relationChange of relationChanges) {
    if (JSON.stringify(relationChange.before) !== JSON.stringify(relationChange.after)) {
      changedFields.add(relationChange.field)
    }
  }

  return [...changedFields]
}

/**
 * The pre-write value of each field `computeChangedFields` reported as changed.
 *
 * Not a second differ — it reads the field list the differ already produced and
 * projects the old row through it, so the two can never disagree about what
 * changed.
 */
function pickPrevious(
  existingTask: Task | undefined,
  changedFields: string[],
  overrides: Partial<Task> = {}
): Partial<Task> {
  const previous: Partial<Task> = {}
  if (existingTask) {
    for (const field of changedFields) {
      const key = field as keyof Task
      if (key in existingTask) {
        ;(previous as Record<string, unknown>)[field] = existingTask[key]
      }
    }
  }
  return { ...previous, ...overrides }
}

function mergeTaskRelations(
  task: Task,
  relations: Partial<Pick<Task, 'tags' | 'linkedNoteIds' | 'linkedCanvasIds'>>
): Task {
  return {
    ...task,
    ...(relations.tags !== undefined ? { tags: relations.tags } : {}),
    ...(relations.linkedNoteIds !== undefined ? { linkedNoteIds: relations.linkedNoteIds } : {}),
    ...(relations.linkedCanvasIds !== undefined
      ? { linkedCanvasIds: relations.linkedCanvasIds }
      : {})
  }
}

/**
 * `tasks.status_id` is FK-bound with ON DELETE SET NULL, so null IS the
 * schema's own answer for a status that no longer exists. A project sync
 * reconciles statuses away underneath renderer caches that still hold the old
 * id, and the next edit echoes that dead id back into the write. Drop the
 * dangling reference rather than failing the edit on a raw constraint.
 *
 * `undefined` means "not part of this edit" and must survive as `undefined`,
 * because definedUpdates() strips it and drizzle omits it from `.set()`.
 *
 * The sync path already does this in main/sync/item-handlers/task-handler.ts;
 * only the local write was unguarded, which is why the constraint fired here.
 */
function resolveStatusId<T extends string | null | undefined>(
  repository: TasksCommandRepository,
  statusId: T
): T | null {
  if (statusId === undefined || statusId === null) return statusId
  return repository.getStatus(statusId) ? statusId : null
}

/**
 * `tasks.project_id` is NOT NULL and FK-bound, so an absent project makes the
 * row unwritable. Report it as a real message instead of SQLite's anonymous
 * `FOREIGN KEY constraint failed`.
 */
function projectIsMissing(
  repository: TasksCommandRepository,
  projectId: string | undefined
): boolean {
  return projectId !== undefined && !repository.getProject(projectId)
}

const PROJECT_MISSING_ERROR = 'errors:task.projectMissing'

export function createTasksCommands({
  repository,
  publisher,
  generateId
}: CreateTasksCommandsDeps) {
  return {
    async createTask(input: TaskCreateInput) {
      if (projectIsMissing(repository, input.projectId)) {
        return { success: false as const, task: null, error: PROJECT_MISSING_ERROR }
      }

      const id = generateId()
      const position =
        input.position ?? repository.getNextTaskPosition(input.projectId, input.parentId)

      const createdTask = repository.createTask({
        id,
        projectId: input.projectId,
        statusId: resolveStatusId(repository, input.statusId ?? null),
        parentId: input.parentId ?? null,
        title: input.title,
        description: input.description ?? null,
        priority: (input.priority ?? 0) as Task['priority'],
        position,
        dueDate: input.dueDate ?? null,
        dueTime: input.dueTime ?? null,
        startDate: input.startDate ?? null,
        repeatConfig: input.repeatConfig ?? null,
        repeatFrom: input.repeatFrom ?? null,
        sourceNoteId: input.sourceNoteId ?? null,
        completedAt: null,
        archivedAt: null,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString()
      })

      if (input.tags && input.tags.length > 0) {
        repository.setTaskTags(id, input.tags)
      }

      if (input.linkedNoteIds && input.linkedNoteIds.length > 0) {
        repository.setTaskNotes(id, input.linkedNoteIds)
      }

      if (input.linkedCanvasIds && input.linkedCanvasIds.length > 0) {
        repository.setTaskCanvases(id, input.linkedCanvasIds)
      }

      const task = mergeTaskRelations(createdTask, {
        tags: input.tags ?? createdTask.tags,
        linkedNoteIds: input.linkedNoteIds ?? createdTask.linkedNoteIds,
        linkedCanvasIds: input.linkedCanvasIds ?? createdTask.linkedCanvasIds
      })
      await publisher.taskCreated({ task })

      return { success: true, task }
    },

    async updateTask(input: TaskUpdateInput) {
      const { id, tags, linkedNoteIds, linkedCanvasIds, priority, ...rawUpdates } = input
      const existingTask = repository.getTask(id)

      const updates: Partial<Task> = definedUpdates({
        ...rawUpdates,
        ...(priority !== undefined ? { priority: priority as Task['priority'] } : {})
      })

      if (projectIsMissing(repository, updates.projectId)) {
        return { success: false as const, task: null, error: PROJECT_MISSING_ERROR }
      }

      if (updates.projectId && existingTask && existingTask.projectId !== updates.projectId) {
        const currentStatus = existingTask.statusId
          ? repository.getStatus(existingTask.statusId)
          : undefined
        const equivalentStatus = repository.getEquivalentStatus(updates.projectId, currentStatus)
        if (equivalentStatus) {
          updates.statusId = equivalentStatus.id
        }
      }

      // Guarded: a bare assignment would re-add a `statusId: undefined` key that
      // definedUpdates() just stripped, and computeChangedFields() would then
      // report a cleared status on every edit that never touched it.
      if (updates.statusId !== undefined) {
        updates.statusId = resolveStatusId(repository, updates.statusId)
      }

      const oldTags = tags !== undefined ? repository.getTaskTags(id) : undefined
      const oldNoteIds = linkedNoteIds !== undefined ? repository.getTaskNoteIds(id) : undefined
      const oldCanvasIds =
        linkedCanvasIds !== undefined ? repository.getTaskCanvasIds(id) : undefined

      const task = repository.updateTask(id, updates)
      if (!task) {
        return { success: false, task: null, error: 'Task not found' }
      }

      if (tags !== undefined) {
        repository.setTaskTags(id, tags)
      }

      if (linkedNoteIds !== undefined) {
        repository.setTaskNotes(id, linkedNoteIds)
      }

      if (linkedCanvasIds !== undefined) {
        repository.setTaskCanvases(id, linkedCanvasIds)
      }

      const resolvedTask: Task = {
        ...task,
        ...(tags !== undefined ? { tags } : {}),
        ...(linkedNoteIds !== undefined ? { linkedNoteIds } : {}),
        ...(linkedCanvasIds !== undefined ? { linkedCanvasIds } : {})
      }
      const changedFields = computeChangedFields(existingTask, updates, [
        {
          field: 'tags',
          before: oldTags,
          after: tags
        },
        {
          field: 'linkedNoteIds',
          before: oldNoteIds,
          after: linkedNoteIds
        },
        {
          field: 'linkedCanvasIds',
          before: oldCanvasIds,
          after: linkedCanvasIds
        }
      ])

      const changes: Partial<Task> = {
        ...updates,
        ...(tags !== undefined ? { tags } : {}),
        ...(linkedNoteIds !== undefined ? { linkedNoteIds } : {}),
        ...(linkedCanvasIds !== undefined ? { linkedCanvasIds } : {})
      }

      await publisher.taskUpdated({
        id,
        task: resolvedTask,
        changes,
        changedFields,
        // Relations live in their own tables, so `existingTask.tags` is not the
        // pre-write truth — the explicit reads above are.
        previous: pickPrevious(existingTask, changedFields, {
          ...(oldTags !== undefined ? { tags: oldTags } : {}),
          ...(oldNoteIds !== undefined ? { linkedNoteIds: oldNoteIds } : {}),
          ...(oldCanvasIds !== undefined ? { linkedCanvasIds: oldCanvasIds } : {})
        })
      })

      return { success: true, task: resolvedTask }
    },

    async deleteTask(id: string) {
      const snapshot = repository.getTask(id)
      repository.deleteTask(id)
      await publisher.taskDeleted({ id, snapshot })
      return { success: true }
    },

    async completeTask(input: TaskCompleteInput) {
      // Pre-read: completeTask writes before it returns, so by the time we have
      // `task` the old completedAt is already gone.
      const before = repository.getTask(input.id)
      const task = repository.completeTask(input.id, input.completedAt)
      if (!task) {
        return { success: false, task: null, error: 'Task not found' }
      }

      await publisher.taskCompleted({
        id: input.id,
        task,
        previous: { completedAt: before?.completedAt ?? null }
      })
      return { success: true, task }
    },

    async uncompleteTask(id: string) {
      const before = repository.getTask(id)
      const task = repository.uncompleteTask(id)
      if (!task) {
        return { success: false, task: null, error: 'Task not found' }
      }

      await publisher.taskUpdated({
        id,
        task,
        changes: { completedAt: null },
        changedFields: ['completedAt'],
        previous: { completedAt: before?.completedAt ?? null }
      })
      return { success: true, task }
    },

    async archiveTask(id: string) {
      const before = repository.getTask(id)
      const task = repository.archiveTask(id)
      if (!task) {
        return { success: false, error: 'Task not found' }
      }

      await publisher.taskUpdated({
        id,
        task,
        changes: { archivedAt: task.archivedAt },
        changedFields: ['archivedAt'],
        previous: { archivedAt: before?.archivedAt ?? null }
      })
      return { success: true }
    },

    async unarchiveTask(id: string) {
      const before = repository.getTask(id)
      const task = repository.unarchiveTask(id)
      if (!task) {
        return { success: false, error: 'Task not found' }
      }

      await publisher.taskUpdated({
        id,
        task,
        changes: { archivedAt: null },
        changedFields: ['archivedAt'],
        previous: { archivedAt: before?.archivedAt ?? null }
      })
      return { success: true }
    },

    async moveTask(input: TaskMoveInput) {
      if (projectIsMissing(repository, input.targetProjectId)) {
        return { success: false as const, task: null, error: PROJECT_MISSING_ERROR }
      }

      const before = repository.getTask(input.taskId)
      let targetStatusId = input.targetStatusId
      if (input.targetProjectId && !targetStatusId) {
        const currentTask = before
        if (currentTask && currentTask.projectId !== input.targetProjectId) {
          const currentStatus = currentTask.statusId
            ? repository.getStatus(currentTask.statusId)
            : undefined
          const equivalentStatus = repository.getEquivalentStatus(
            input.targetProjectId,
            currentStatus
          )
          if (equivalentStatus) {
            targetStatusId = equivalentStatus.id
          }
        }
      }

      const task = repository.moveTask(input.taskId, {
        projectId: input.targetProjectId,
        statusId: resolveStatusId(repository, targetStatusId),
        parentId: input.targetParentId,
        position: input.position
      })

      if (!task) {
        return { success: false, task: null, error: 'Task not found' }
      }

      const changedFields = ['position']
      if (input.targetProjectId) changedFields.push('projectId')
      if (targetStatusId !== undefined) changedFields.push('statusId')
      if (input.targetParentId !== undefined) changedFields.push('parentId')

      await publisher.taskMoved({
        id: input.taskId,
        task,
        changedFields,
        previous: pickPrevious(before, changedFields)
      })

      return { success: true, task }
    },

    async reorderTasks(taskIds: string[], positions: number[]) {
      repository.reorderTasks(taskIds, positions)

      for (const taskId of taskIds) {
        if (publisher.taskReordered) {
          await publisher.taskReordered({
            id: taskId,
            changedFields: ['position']
          })
          continue
        }

        const task = repository.getTask(taskId)
        if (!task) {
          continue
        }

        await publisher.taskUpdated({
          id: taskId,
          task,
          changes: { position: task.position },
          changedFields: ['position']
        })
      }

      return { success: true }
    },

    async duplicateTask(id: string) {
      const newId = generateId()
      const duplicatedTask = repository.duplicateTask(id, newId)
      if (!duplicatedTask) {
        return { success: false, task: null, error: 'Task not found' }
      }

      const tags = repository.getTaskTags(id)
      if (tags.length > 0) {
        repository.setTaskTags(newId, tags)
      }

      const linkedNoteIds = repository.getTaskNoteIds(id)
      if (linkedNoteIds.length > 0) {
        repository.setTaskNotes(newId, linkedNoteIds)
      }

      const linkedCanvasIds = repository.getTaskCanvasIds(id)
      if (linkedCanvasIds.length > 0) {
        repository.setTaskCanvases(newId, linkedCanvasIds)
      }

      const resolvedTask = mergeTaskRelations(duplicatedTask, {
        tags: tags.length > 0 ? tags : duplicatedTask.tags,
        linkedNoteIds: linkedNoteIds.length > 0 ? linkedNoteIds : duplicatedTask.linkedNoteIds,
        linkedCanvasIds:
          linkedCanvasIds.length > 0 ? linkedCanvasIds : duplicatedTask.linkedCanvasIds
      })
      await publisher.taskCreated({ task: resolvedTask })

      const subtasks = repository.getSubtasks(id)
      for (const subtask of subtasks) {
        const newSubtaskId = generateId()
        const duplicatedSubtask = repository.duplicateSubtask(subtask.id, newSubtaskId, newId)
        if (!duplicatedSubtask) continue

        const subtaskTags = repository.getTaskTags(subtask.id)
        if (subtaskTags.length > 0) {
          repository.setTaskTags(newSubtaskId, subtaskTags)
        }

        const subtaskNoteIds = repository.getTaskNoteIds(subtask.id)
        if (subtaskNoteIds.length > 0) {
          repository.setTaskNotes(newSubtaskId, subtaskNoteIds)
        }

        const subtaskCanvasIds = repository.getTaskCanvasIds(subtask.id)
        if (subtaskCanvasIds.length > 0) {
          repository.setTaskCanvases(newSubtaskId, subtaskCanvasIds)
        }

        const resolvedSubtask = mergeTaskRelations(duplicatedSubtask, {
          tags: subtaskTags.length > 0 ? subtaskTags : duplicatedSubtask.tags,
          linkedNoteIds:
            subtaskNoteIds.length > 0 ? subtaskNoteIds : duplicatedSubtask.linkedNoteIds,
          linkedCanvasIds:
            subtaskCanvasIds.length > 0 ? subtaskCanvasIds : duplicatedSubtask.linkedCanvasIds
        })
        await publisher.taskCreated({ task: resolvedSubtask })
      }

      return { success: true, task: resolvedTask }
    },

    async convertToSubtask(taskId: string, parentId: string) {
      const before = repository.getTask(taskId)
      const task = repository.moveTask(taskId, { parentId })
      if (!task) {
        return { success: false, task: null, error: 'Task not found' }
      }

      await publisher.taskUpdated({
        id: taskId,
        task,
        changes: { parentId },
        changedFields: ['parentId'],
        previous: { parentId: before?.parentId ?? null }
      })

      return { success: true, task }
    },

    async convertToTask(taskId: string) {
      const before = repository.getTask(taskId)
      const task = repository.moveTask(taskId, { parentId: null })
      if (!task) {
        return { success: false, task: null, error: 'Task not found' }
      }

      await publisher.taskUpdated({
        id: taskId,
        task,
        changes: { parentId: null },
        changedFields: ['parentId'],
        previous: { parentId: before?.parentId ?? null }
      })

      return { success: true, task }
    },

    async createProject(input: ProjectCreateInput) {
      const id = generateId()
      const position = repository.getNextProjectPosition()

      repository.createProject({
        id,
        name: input.name,
        description: input.description ?? null,
        color: input.color ?? '#6366f1',
        icon: input.icon ?? null,
        position,
        isInbox: false
      })

      if (input.statuses && input.statuses.length >= 2) {
        repository.createCustomStatuses(id, input.statuses)
      } else {
        repository.createDefaultStatuses(id)
      }

      const project = repository.getProject(id)
      if (!project) {
        throw new Error('Project not found after create')
      }

      await publisher.projectCreated({ project })
      return { success: true, project }
    },

    async updateProject(input: ProjectUpdateInput) {
      const { id, statuses, ...metadataUpdates } = input
      const project = repository.updateProject(id, metadataUpdates)
      if (!project) {
        return { success: false, project: null, error: 'Project not found' }
      }

      if (statuses) {
        repository.reconcileProjectStatuses(id, statuses)
      }

      const resolvedProject = repository.getProject(id)
      if (!resolvedProject) {
        throw new Error('Project not found after update')
      }

      await publisher.projectUpdated({
        id,
        project: resolvedProject,
        changedFields: [...Object.keys(metadataUpdates), ...(statuses ? ['statuses'] : [])]
      })

      return { success: true, project: resolvedProject }
    },

    async deleteProject(id: string) {
      const snapshot = repository.getProject(id)
      // SQLite cascades this project's tasks away locally, but a cascade is
      // invisible to sync: without an explicit tombstone per task the server
      // keeps them alive forever, and every device then re-pulls a task whose
      // project_id no longer resolves — FOREIGN KEY constraint failed on every
      // cycle, item skipped, manifest still sees it server-only, re-pull (#837).
      const cascadedTasks = repository.listTasks({
        projectId: id,
        includeCompleted: true,
        includeArchived: true
      })
      repository.deleteProject(id)
      await publisher.projectDeleted({ id, snapshot })
      for (const task of cascadedTasks) {
        await publisher.taskDeleted({ id: task.id, snapshot: task })
      }
      return { success: true }
    },

    async linkItemToProject(input: ProjectLinkItemInput) {
      // Validate before inserting — project_links.project_id carries a FK, so an
      // unknown (or concurrently deleted) project would throw past the structured
      // `{ success: false, error }` response instead of returning it.
      const project = repository.getProject(input.projectId)
      if (!project) {
        return { success: false, error: 'Project not found' }
      }

      const existing = repository.findProjectLink(input.projectId, input.itemType, input.itemId)
      if (!existing) {
        repository.linkItemToProject({
          id: generateId(),
          projectId: input.projectId,
          itemType: input.itemType,
          itemId: input.itemId
        })
      }

      await publisher.projectUpdated({ id: input.projectId, project, changedFields: ['links'] })
      return { success: true }
    },

    async unlinkItemFromProject(input: ProjectLinkItemInput) {
      repository.unlinkItemFromProject(input.projectId, input.itemType, input.itemId)

      const project = repository.getProject(input.projectId)
      if (!project) {
        return { success: false, error: 'Project not found' }
      }

      await publisher.projectUpdated({ id: input.projectId, project, changedFields: ['links'] })
      return { success: true }
    },

    async setProjectLinkPinned(input: ProjectSetLinkPinnedInput) {
      repository.setProjectLinkPinned(input.projectId, input.itemId, input.pinned)

      const project = repository.getProject(input.projectId)
      if (!project) {
        return { success: false, error: 'Project not found' }
      }

      await publisher.projectUpdated({ id: input.projectId, project, changedFields: ['links'] })
      return { success: true }
    },

    async setProjectHomeNote(input: ProjectSetHomeNoteInput) {
      repository.setProjectHomeNote(input.projectId, input.noteId)

      const project = repository.getProject(input.projectId)
      if (!project) {
        return { success: false, error: 'Project not found' }
      }

      await publisher.projectUpdated({
        id: input.projectId,
        project,
        changedFields: ['homeNoteId']
      })
      return { success: true, project }
    },

    // A note's links + home-note references only sync because the project payload
    // carries them, so removing them must re-enqueue each affected project through
    // the same publisher.projectUpdated(...) path as link/unlink/set-home-note.
    async cleanupProjectLinksForDeletedNote(noteId: string) {
      const fromLinks = repository.deleteProjectLinksForItem('note', noteId)
      const fromHome = repository.clearProjectsHomeNote(noteId)

      const changedByProject = new Map<string, string[]>()
      for (const id of fromLinks) changedByProject.set(id, ['links'])
      for (const id of fromHome) {
        const existing = changedByProject.get(id)
        changedByProject.set(id, existing ? [...existing, 'homeNoteId'] : ['homeNoteId'])
      }

      for (const [projectId, changedFields] of changedByProject) {
        const project = repository.getProject(projectId)
        if (project) {
          await publisher.projectUpdated({ id: projectId, project, changedFields })
        }
      }

      return { success: true }
    },

    async archiveProject(id: string) {
      const project = repository.archiveProject(id)
      if (!project) {
        return { success: false, error: 'Project not found' }
      }

      const resolvedProject = repository.getProject(id)
      await publisher.projectUpdated({
        id,
        project: resolvedProject ?? project,
        changedFields: ['archivedAt']
      })

      return { success: true }
    },

    async reorderProjects(projectIds: string[], positions: number[]) {
      repository.reorderProjects(projectIds, positions)

      for (const projectId of projectIds) {
        const project = repository.getProject(projectId)
        if (project) {
          await publisher.projectUpdated({
            id: projectId,
            project,
            changedFields: ['position']
          })
        }
      }

      return { success: true }
    },

    async createStatus(input: StatusCreateInput) {
      const status = repository.createStatus({
        id: generateId(),
        projectId: input.projectId,
        name: input.name,
        color: input.color ?? '#6b7280',
        position: repository.getNextStatusPosition(input.projectId),
        isDefault: false,
        isDone: input.isDone ?? false
      })

      await publisher.statusCreated({ status })
      return { success: true, status }
    },

    async updateStatus(input: StatusUpdateInput) {
      const { id, ...updates } = input
      const status = repository.updateStatus(id, updates)
      if (!status) {
        return { success: false, error: 'Status not found' }
      }

      const resolvedStatus = repository.getStatus(id) ?? status
      await publisher.statusUpdated({ status: resolvedStatus })
      return { success: true, status: resolvedStatus }
    },

    async deleteStatus(id: string) {
      const status = repository.getStatus(id)
      repository.deleteStatus(id)
      if (status) {
        await publisher.statusDeleted({ id, projectId: status.projectId })
      }
      return { success: true }
    },

    async reorderStatuses(statusIds: string[], positions: number[]) {
      repository.reorderStatuses(statusIds, positions)
      for (const statusId of statusIds) {
        const status = repository.getStatus(statusId)
        if (status) {
          await publisher.statusUpdated({ status })
        }
      }
      return { success: true }
    },

    async bulkComplete(ids: string[]) {
      // The bulk write is a single `UPDATE … WHERE id IN (…)`, so per-row
      // before-state costs one extra read per id. Accepted: the loop below
      // already reads each row once, and selections are user-sized.
      const before = new Map(ids.map((id) => [id, repository.getTask(id)]))
      const count = repository.bulkCompleteTasks(ids)
      for (const id of ids) {
        const task = repository.getTask(id)
        if (task) {
          await publisher.taskCompleted({
            id,
            task,
            previous: { completedAt: before.get(id)?.completedAt ?? null }
          })
        }
      }
      return { success: true, count }
    },

    async bulkDelete(ids: string[]) {
      const snapshots = ids.map((id) => repository.getTask(id))
      const count = repository.bulkDeleteTasks(ids)
      for (let index = 0; index < ids.length; index += 1) {
        await publisher.taskDeleted({ id: ids[index], snapshot: snapshots[index] })
      }
      return { success: true, count }
    },

    async bulkMove(ids: string[], projectId: string) {
      const before = new Map(ids.map((id) => [id, repository.getTask(id)]))
      const count = repository.bulkMoveTasks(ids, projectId)
      for (const id of ids) {
        const task = repository.getTask(id)
        if (task) {
          await publisher.taskUpdated({
            id,
            task,
            changes: { projectId },
            changedFields: ['projectId', 'position'],
            previous: pickPrevious(before.get(id), ['projectId', 'position'])
          })
        }
      }
      return { success: true, count }
    },

    async bulkArchive(ids: string[]) {
      const before = new Map(ids.map((id) => [id, repository.getTask(id)]))
      const count = repository.bulkArchiveTasks(ids)
      for (const id of ids) {
        const task = repository.getTask(id)
        if (task) {
          await publisher.taskUpdated({
            id,
            task,
            changes: { archivedAt: task.archivedAt },
            changedFields: ['archivedAt'],
            previous: { archivedAt: before.get(id)?.archivedAt ?? null }
          })
        }
      }
      return { success: true, count }
    }
  }
}
