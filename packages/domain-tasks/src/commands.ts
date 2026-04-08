import type { Project, ProjectWithStatuses, Status, Task } from './types'
import type { TasksQueryRepository } from './queries'

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
  createTask(task: Omit<Task, 'tags' | 'linkedNoteIds' | 'hasSubtasks' | 'subtaskCount' | 'completedSubtaskCount'>): Task
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

export interface TaskUpdatedEvent {
  id: string
  task: Task
  changes: Partial<Task>
  changedFields: string[]
}

export interface TaskMovedEvent {
  id: string
  task: Task
  changedFields: string[]
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
  taskCompleted(event: { id: string; task: Task }): void | Promise<void>
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

function mergeTaskRelations(
  task: Task,
  relations: Partial<Pick<Task, 'tags' | 'linkedNoteIds'>>
): Task {
  return {
    ...task,
    ...(relations.tags !== undefined ? { tags: relations.tags } : {}),
    ...(relations.linkedNoteIds !== undefined ? { linkedNoteIds: relations.linkedNoteIds } : {})
  }
}

export function createTasksCommands({
  repository,
  publisher,
  generateId
}: CreateTasksCommandsDeps) {
  return {
    async createTask(input: TaskCreateInput) {
      const id = generateId()
      const position = input.position ?? repository.getNextTaskPosition(input.projectId, input.parentId)

      const createdTask = repository.createTask({
        id,
        projectId: input.projectId,
        statusId: input.statusId ?? null,
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

      const task = mergeTaskRelations(createdTask, {
        tags: input.tags ?? createdTask.tags,
        linkedNoteIds: input.linkedNoteIds ?? createdTask.linkedNoteIds
      })
      await publisher.taskCreated({ task })

      return { success: true, task }
    },

    async updateTask(input: TaskUpdateInput) {
      const { id, tags, linkedNoteIds, priority, ...rawUpdates } = input
      const existingTask = repository.getTask(id)

      const updates: Partial<Task> = {
        ...rawUpdates,
        ...(priority !== undefined ? { priority: priority as Task['priority'] } : {})
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

      const oldTags = tags !== undefined ? repository.getTaskTags(id) : undefined
      const oldNoteIds = linkedNoteIds !== undefined ? repository.getTaskNoteIds(id) : undefined

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

      const resolvedTask: Task = {
        ...task,
        ...(tags !== undefined ? { tags } : {}),
        ...(linkedNoteIds !== undefined ? { linkedNoteIds } : {})
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
        }
      ])

      const changes: Partial<Task> = {
        ...updates,
        ...(tags !== undefined ? { tags } : {}),
        ...(linkedNoteIds !== undefined ? { linkedNoteIds } : {})
      }

      await publisher.taskUpdated({
        id,
        task: resolvedTask,
        changes,
        changedFields
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
      const task = repository.completeTask(input.id, input.completedAt)
      if (!task) {
        return { success: false, task: null, error: 'Task not found' }
      }

      await publisher.taskCompleted({ id: input.id, task })
      return { success: true, task }
    },

    async uncompleteTask(id: string) {
      const task = repository.uncompleteTask(id)
      if (!task) {
        return { success: false, task: null, error: 'Task not found' }
      }

      await publisher.taskUpdated({
        id,
        task,
        changes: { completedAt: null },
        changedFields: ['completedAt']
      })
      return { success: true, task }
    },

    async archiveTask(id: string) {
      const task = repository.archiveTask(id)
      if (!task) {
        return { success: false, error: 'Task not found' }
      }

      await publisher.taskUpdated({
        id,
        task,
        changes: { archivedAt: task.archivedAt },
        changedFields: ['archivedAt']
      })
      return { success: true }
    },

    async unarchiveTask(id: string) {
      const task = repository.unarchiveTask(id)
      if (!task) {
        return { success: false, error: 'Task not found' }
      }

      await publisher.taskUpdated({
        id,
        task,
        changes: { archivedAt: null },
        changedFields: ['archivedAt']
      })
      return { success: true }
    },

    async moveTask(input: TaskMoveInput) {
      let targetStatusId = input.targetStatusId
      if (input.targetProjectId && !targetStatusId) {
        const currentTask = repository.getTask(input.taskId)
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
        statusId: targetStatusId,
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
        changedFields
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

      const resolvedTask = mergeTaskRelations(duplicatedTask, {
        tags: tags.length > 0 ? tags : duplicatedTask.tags,
        linkedNoteIds: linkedNoteIds.length > 0 ? linkedNoteIds : duplicatedTask.linkedNoteIds
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

        const resolvedSubtask = mergeTaskRelations(duplicatedSubtask, {
          tags: subtaskTags.length > 0 ? subtaskTags : duplicatedSubtask.tags,
          linkedNoteIds:
            subtaskNoteIds.length > 0 ? subtaskNoteIds : duplicatedSubtask.linkedNoteIds
        })
        await publisher.taskCreated({ task: resolvedSubtask })
      }

      return { success: true, task: resolvedTask }
    },

    async convertToSubtask(taskId: string, parentId: string) {
      const task = repository.moveTask(taskId, { parentId })
      if (!task) {
        return { success: false, task: null, error: 'Task not found' }
      }

      await publisher.taskUpdated({
        id: taskId,
        task,
        changes: { parentId },
        changedFields: ['parentId']
      })

      return { success: true, task }
    },

    async convertToTask(taskId: string) {
      const task = repository.moveTask(taskId, { parentId: null })
      if (!task) {
        return { success: false, task: null, error: 'Task not found' }
      }

      await publisher.taskUpdated({
        id: taskId,
        task,
        changes: { parentId: null },
        changedFields: ['parentId']
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
      repository.deleteProject(id)
      await publisher.projectDeleted({ id, snapshot })
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
      const count = repository.bulkCompleteTasks(ids)
      for (const id of ids) {
        const task = repository.getTask(id)
        if (task) {
          await publisher.taskCompleted({ id, task })
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
      const count = repository.bulkMoveTasks(ids, projectId)
      for (const id of ids) {
        const task = repository.getTask(id)
        if (task) {
          await publisher.taskUpdated({
            id,
            task,
            changes: { projectId },
            changedFields: ['projectId', 'position']
          })
        }
      }
      return { success: true, count }
    },

    async bulkArchive(ids: string[]) {
      const count = repository.bulkArchiveTasks(ids)
      for (const id of ids) {
        const task = repository.getTask(id)
        if (task) {
          await publisher.taskUpdated({
            id,
            task,
            changes: { archivedAt: task.archivedAt },
            changedFields: ['archivedAt']
          })
        }
      }
      return { success: true, count }
    }
  }
}
