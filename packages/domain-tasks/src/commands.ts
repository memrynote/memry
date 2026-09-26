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

/**
 * One publisher call, as data. A command's write phase returns these so the
 * host can derive what the change owes other systems (sync) inside the same
 * storage transaction; the publisher receives them only after it commits.
 */
export type TasksDomainEvent =
  | { kind: 'taskCreated'; payload: { task: Task } }
  | { kind: 'taskUpdated'; payload: TaskUpdatedEvent }
  | { kind: 'taskDeleted'; payload: { id: string; snapshot?: Task } }
  | { kind: 'taskCompleted'; payload: TaskCompletedEvent }
  | { kind: 'taskMoved'; payload: TaskMovedEvent }
  | { kind: 'taskReordered'; payload: { id: string; changedFields: string[] } }
  | { kind: 'projectCreated'; payload: { project: ProjectWithStatuses | Project } }
  | { kind: 'projectUpdated'; payload: ProjectUpdatedEvent }
  | { kind: 'projectDeleted'; payload: { id: string; snapshot?: ProjectWithStatuses } }
  | { kind: 'statusCreated'; payload: StatusEvent }
  | { kind: 'statusUpdated'; payload: StatusEvent }
  | { kind: 'statusDeleted'; payload: StatusDeletedEvent }

export interface TasksWrite<T> {
  result: T
  events: readonly TasksDomainEvent[]
}

/**
 * Runs a command's synchronous write phase as one storage transaction and
 * returns after it commits. A throw rolls back every write in it.
 */
export interface TasksUnitOfWork {
  run<W extends TasksWrite<unknown>>(write: () => W): W
}

export interface CreateTasksCommandsDeps {
  repository: TasksCommandRepository
  publisher: TasksDomainPublisher
  generateId: () => string
  /** Absent: each repository call commits on its own, as before #2301. */
  unitOfWork?: TasksUnitOfWork
  /**
   * A publisher call threw. The write had already committed, so the remaining
   * events are still published and the command still resolves.
   */
  onPublisherError?: (kind: TasksDomainEvent['kind'], error: unknown) => void
}

const AUTOCOMMIT_UNIT_OF_WORK: TasksUnitOfWork = {
  run: (write) => write()
}

function publishTasksEvent(
  publisher: TasksDomainPublisher,
  event: TasksDomainEvent
): void | Promise<void> {
  switch (event.kind) {
    case 'taskCreated':
      return publisher.taskCreated(event.payload)
    case 'taskUpdated':
      return publisher.taskUpdated(event.payload)
    case 'taskDeleted':
      return publisher.taskDeleted(event.payload)
    case 'taskCompleted':
      return publisher.taskCompleted(event.payload)
    case 'taskMoved':
      return publisher.taskMoved(event.payload)
    case 'taskReordered':
      return publisher.taskReordered?.(event.payload)
    case 'projectCreated':
      return publisher.projectCreated(event.payload)
    case 'projectUpdated':
      return publisher.projectUpdated(event.payload)
    case 'projectDeleted':
      return publisher.projectDeleted(event.payload)
    case 'statusCreated':
      return publisher.statusCreated(event.payload)
    case 'statusUpdated':
      return publisher.statusUpdated(event.payload)
    case 'statusDeleted':
      return publisher.statusDeleted(event.payload)
  }
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
  generateId,
  unitOfWork = AUTOCOMMIT_UNIT_OF_WORK,
  onPublisherError
}: CreateTasksCommandsDeps) {
  // The write phase commits before any publisher code runs: the publisher is
  // async and does I/O, which a synchronous storage transaction cannot span.
  async function commit<W extends TasksWrite<unknown>>(write: () => W): Promise<W['result']> {
    const { result, events } = unitOfWork.run(write)
    for (const event of events) {
      try {
        await publishTasksEvent(publisher, event)
      } catch (error) {
        onPublisherError?.(event.kind, error)
      }
    }
    return result
  }

  return {
    async createTask(input: TaskCreateInput) {
      return commit(() => {
        if (projectIsMissing(repository, input.projectId)) {
          return {
            result: { success: false as const, task: null, error: PROJECT_MISSING_ERROR },
            events: []
          }
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
        const events: TasksDomainEvent[] = [{ kind: 'taskCreated', payload: { task } }]
        return { result: { success: true, task }, events }
      })
    },

    async updateTask(input: TaskUpdateInput) {
      return commit(() => {
        const { id, tags, linkedNoteIds, linkedCanvasIds, priority, ...rawUpdates } = input
        const existingTask = repository.getTask(id)

        const updates: Partial<Task> = definedUpdates({
          ...rawUpdates,
          ...(priority !== undefined ? { priority: priority as Task['priority'] } : {})
        })

        if (projectIsMissing(repository, updates.projectId)) {
          return {
            result: { success: false as const, task: null, error: PROJECT_MISSING_ERROR },
            events: []
          }
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
          return { result: { success: false, task: null, error: 'Task not found' }, events: [] }
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

        const events: TasksDomainEvent[] = [
          {
            kind: 'taskUpdated',
            payload: {
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
            }
          }
        ]
        return { result: { success: true, task: resolvedTask }, events }
      })
    },

    async deleteTask(id: string) {
      return commit(() => {
        const snapshot = repository.getTask(id)
        repository.deleteTask(id)
        const events: TasksDomainEvent[] = [{ kind: 'taskDeleted', payload: { id, snapshot } }]
        return { result: { success: true }, events }
      })
    },

    async completeTask(input: TaskCompleteInput) {
      return commit(() => {
        // Pre-read: completeTask writes before it returns, so by the time we have
        // `task` the old completedAt is already gone.
        const before = repository.getTask(input.id)
        const task = repository.completeTask(input.id, input.completedAt)
        if (!task) {
          return { result: { success: false, task: null, error: 'Task not found' }, events: [] }
        }

        const events: TasksDomainEvent[] = [
          {
            kind: 'taskCompleted',
            payload: {
              id: input.id,
              task,
              previous: { completedAt: before?.completedAt ?? null }
            }
          }
        ]
        return { result: { success: true, task }, events }
      })
    },

    async uncompleteTask(id: string) {
      return commit(() => {
        const before = repository.getTask(id)
        const task = repository.uncompleteTask(id)
        if (!task) {
          return { result: { success: false, task: null, error: 'Task not found' }, events: [] }
        }

        const events: TasksDomainEvent[] = [
          {
            kind: 'taskUpdated',
            payload: {
              id,
              task,
              changes: { completedAt: null },
              changedFields: ['completedAt'],
              previous: { completedAt: before?.completedAt ?? null }
            }
          }
        ]
        return { result: { success: true, task }, events }
      })
    },

    async archiveTask(id: string) {
      return commit(() => {
        const before = repository.getTask(id)
        const task = repository.archiveTask(id)
        if (!task) {
          return { result: { success: false, error: 'Task not found' }, events: [] }
        }

        const events: TasksDomainEvent[] = [
          {
            kind: 'taskUpdated',
            payload: {
              id,
              task,
              changes: { archivedAt: task.archivedAt },
              changedFields: ['archivedAt'],
              previous: { archivedAt: before?.archivedAt ?? null }
            }
          }
        ]
        return { result: { success: true }, events }
      })
    },

    async unarchiveTask(id: string) {
      return commit(() => {
        const before = repository.getTask(id)
        const task = repository.unarchiveTask(id)
        if (!task) {
          return { result: { success: false, error: 'Task not found' }, events: [] }
        }

        const events: TasksDomainEvent[] = [
          {
            kind: 'taskUpdated',
            payload: {
              id,
              task,
              changes: { archivedAt: null },
              changedFields: ['archivedAt'],
              previous: { archivedAt: before?.archivedAt ?? null }
            }
          }
        ]
        return { result: { success: true }, events }
      })
    },

    async moveTask(input: TaskMoveInput) {
      return commit(() => {
        if (projectIsMissing(repository, input.targetProjectId)) {
          return {
            result: { success: false as const, task: null, error: PROJECT_MISSING_ERROR },
            events: []
          }
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
          return { result: { success: false, task: null, error: 'Task not found' }, events: [] }
        }

        const changedFields = ['position']
        if (input.targetProjectId) changedFields.push('projectId')
        if (targetStatusId !== undefined) changedFields.push('statusId')
        if (input.targetParentId !== undefined) changedFields.push('parentId')

        const events: TasksDomainEvent[] = [
          {
            kind: 'taskMoved',
            payload: {
              id: input.taskId,
              task,
              changedFields,
              previous: pickPrevious(before, changedFields)
            }
          }
        ]
        return { result: { success: true, task }, events }
      })
    },

    async reorderTasks(taskIds: string[], positions: number[]) {
      return commit(() => {
        repository.reorderTasks(taskIds, positions)

        const events: TasksDomainEvent[] = []
        for (const taskId of taskIds) {
          if (publisher.taskReordered) {
            events.push({
              kind: 'taskReordered',
              payload: { id: taskId, changedFields: ['position'] }
            })
            continue
          }

          const task = repository.getTask(taskId)
          if (!task) {
            continue
          }

          events.push({
            kind: 'taskUpdated',
            payload: {
              id: taskId,
              task,
              changes: { position: task.position },
              changedFields: ['position']
            }
          })
        }

        return { result: { success: true }, events }
      })
    },

    async duplicateTask(id: string) {
      return commit(() => {
        const newId = generateId()
        const duplicatedTask = repository.duplicateTask(id, newId)
        if (!duplicatedTask) {
          return { result: { success: false, task: null, error: 'Task not found' }, events: [] }
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
        const events: TasksDomainEvent[] = [
          { kind: 'taskCreated', payload: { task: resolvedTask } }
        ]

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
          events.push({ kind: 'taskCreated', payload: { task: resolvedSubtask } })
        }

        return { result: { success: true, task: resolvedTask }, events }
      })
    },

    async convertToSubtask(taskId: string, parentId: string) {
      return commit(() => {
        const before = repository.getTask(taskId)
        const task = repository.moveTask(taskId, { parentId })
        if (!task) {
          return { result: { success: false, task: null, error: 'Task not found' }, events: [] }
        }

        const events: TasksDomainEvent[] = [
          {
            kind: 'taskUpdated',
            payload: {
              id: taskId,
              task,
              changes: { parentId },
              changedFields: ['parentId'],
              previous: { parentId: before?.parentId ?? null }
            }
          }
        ]
        return { result: { success: true, task }, events }
      })
    },

    async convertToTask(taskId: string) {
      return commit(() => {
        const before = repository.getTask(taskId)
        const task = repository.moveTask(taskId, { parentId: null })
        if (!task) {
          return { result: { success: false, task: null, error: 'Task not found' }, events: [] }
        }

        const events: TasksDomainEvent[] = [
          {
            kind: 'taskUpdated',
            payload: {
              id: taskId,
              task,
              changes: { parentId: null },
              changedFields: ['parentId'],
              previous: { parentId: before?.parentId ?? null }
            }
          }
        ]
        return { result: { success: true, task }, events }
      })
    },

    async createProject(input: ProjectCreateInput) {
      return commit(() => {
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

        const events: TasksDomainEvent[] = [{ kind: 'projectCreated', payload: { project } }]
        return { result: { success: true, project }, events }
      })
    },

    async updateProject(input: ProjectUpdateInput) {
      return commit(() => {
        const { id, statuses, ...metadataUpdates } = input
        const project = repository.updateProject(id, metadataUpdates)
        if (!project) {
          return {
            result: { success: false, project: null, error: 'Project not found' },
            events: []
          }
        }

        if (statuses) {
          repository.reconcileProjectStatuses(id, statuses)
        }

        const resolvedProject = repository.getProject(id)
        if (!resolvedProject) {
          throw new Error('Project not found after update')
        }

        const events: TasksDomainEvent[] = [
          {
            kind: 'projectUpdated',
            payload: {
              id,
              project: resolvedProject,
              changedFields: [...Object.keys(metadataUpdates), ...(statuses ? ['statuses'] : [])]
            }
          }
        ]
        return { result: { success: true, project: resolvedProject }, events }
      })
    },

    async deleteProject(id: string) {
      return commit(() => {
        const snapshot = repository.getProject(id)
        // SQLite cascades this project's tasks away locally, but a cascade is
        // invisible to sync: without an explicit tombstone per task the server
        // keeps them alive forever, and every device then re-pulls a task whose
        // project_id no longer resolves — FOREIGN KEY constraint failed on every
        // cycle, item skipped, manifest still sees it server-only, re-pull (#837).
        // The tombstones are events of this write so they commit with the
        // cascade, not one by one after it (#2301).
        // listTasks strips the sync clock; getTask keeps it, and the tombstone
        // is built from the snapshot's clock.
        const cascadedTasks = repository
          .listTasks({ projectId: id, includeCompleted: true, includeArchived: true })
          .map((task) => repository.getTask(task.id) ?? task)
        repository.deleteProject(id)
        const events: TasksDomainEvent[] = [
          { kind: 'projectDeleted', payload: { id, snapshot } },
          ...cascadedTasks.map((task): TasksDomainEvent => ({
            kind: 'taskDeleted',
            payload: { id: task.id, snapshot: task }
          }))
        ]
        return { result: { success: true }, events }
      })
    },

    async linkItemToProject(input: ProjectLinkItemInput) {
      return commit(() => {
        // Validate before inserting — project_links.project_id carries a FK, so an
        // unknown (or concurrently deleted) project would throw past the structured
        // `{ success: false, error }` response instead of returning it.
        const project = repository.getProject(input.projectId)
        if (!project) {
          return { result: { success: false, error: 'Project not found' }, events: [] }
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

        const events: TasksDomainEvent[] = [
          {
            kind: 'projectUpdated',
            payload: { id: input.projectId, project, changedFields: ['links'] }
          }
        ]
        return { result: { success: true }, events }
      })
    },

    async unlinkItemFromProject(input: ProjectLinkItemInput) {
      return commit(() => {
        repository.unlinkItemFromProject(input.projectId, input.itemType, input.itemId)

        const project = repository.getProject(input.projectId)
        if (!project) {
          return { result: { success: false, error: 'Project not found' }, events: [] }
        }

        const events: TasksDomainEvent[] = [
          {
            kind: 'projectUpdated',
            payload: { id: input.projectId, project, changedFields: ['links'] }
          }
        ]
        return { result: { success: true }, events }
      })
    },

    async setProjectLinkPinned(input: ProjectSetLinkPinnedInput) {
      return commit(() => {
        repository.setProjectLinkPinned(input.projectId, input.itemId, input.pinned)

        const project = repository.getProject(input.projectId)
        if (!project) {
          return { result: { success: false, error: 'Project not found' }, events: [] }
        }

        const events: TasksDomainEvent[] = [
          {
            kind: 'projectUpdated',
            payload: { id: input.projectId, project, changedFields: ['links'] }
          }
        ]
        return { result: { success: true }, events }
      })
    },

    async setProjectHomeNote(input: ProjectSetHomeNoteInput) {
      return commit(() => {
        repository.setProjectHomeNote(input.projectId, input.noteId)

        const project = repository.getProject(input.projectId)
        if (!project) {
          return { result: { success: false, error: 'Project not found' }, events: [] }
        }

        const events: TasksDomainEvent[] = [
          {
            kind: 'projectUpdated',
            payload: { id: input.projectId, project, changedFields: ['homeNoteId'] }
          }
        ]
        return { result: { success: true, project }, events }
      })
    },

    // A note's links + home-note references only sync because the project payload
    // carries them, so removing them must re-enqueue each affected project through
    // the same projectUpdated event as link/unlink/set-home-note.
    async cleanupProjectLinksForDeletedNote(noteId: string) {
      return commit(() => {
        const fromLinks = repository.deleteProjectLinksForItem('note', noteId)
        const fromHome = repository.clearProjectsHomeNote(noteId)

        const changedByProject = new Map<string, string[]>()
        for (const id of fromLinks) changedByProject.set(id, ['links'])
        for (const id of fromHome) {
          const existing = changedByProject.get(id)
          changedByProject.set(id, existing ? [...existing, 'homeNoteId'] : ['homeNoteId'])
        }

        const events: TasksDomainEvent[] = []
        for (const [projectId, changedFields] of changedByProject) {
          const project = repository.getProject(projectId)
          if (project) {
            events.push({
              kind: 'projectUpdated',
              payload: { id: projectId, project, changedFields }
            })
          }
        }

        return { result: { success: true }, events }
      })
    },

    async archiveProject(id: string) {
      return commit(() => {
        const project = repository.archiveProject(id)
        if (!project) {
          return { result: { success: false, error: 'Project not found' }, events: [] }
        }

        const resolvedProject = repository.getProject(id)
        const events: TasksDomainEvent[] = [
          {
            kind: 'projectUpdated',
            payload: { id, project: resolvedProject ?? project, changedFields: ['archivedAt'] }
          }
        ]
        return { result: { success: true }, events }
      })
    },

    async reorderProjects(projectIds: string[], positions: number[]) {
      return commit(() => {
        repository.reorderProjects(projectIds, positions)

        const events: TasksDomainEvent[] = []
        for (const projectId of projectIds) {
          const project = repository.getProject(projectId)
          if (project) {
            events.push({
              kind: 'projectUpdated',
              payload: { id: projectId, project, changedFields: ['position'] }
            })
          }
        }

        return { result: { success: true }, events }
      })
    },

    async createStatus(input: StatusCreateInput) {
      return commit(() => {
        const status = repository.createStatus({
          id: generateId(),
          projectId: input.projectId,
          name: input.name,
          color: input.color ?? '#6b7280',
          position: repository.getNextStatusPosition(input.projectId),
          isDefault: false,
          isDone: input.isDone ?? false
        })

        const events: TasksDomainEvent[] = [{ kind: 'statusCreated', payload: { status } }]
        return { result: { success: true, status }, events }
      })
    },

    async updateStatus(input: StatusUpdateInput) {
      return commit(() => {
        const { id, ...updates } = input
        const status = repository.updateStatus(id, updates)
        if (!status) {
          return { result: { success: false, error: 'Status not found' }, events: [] }
        }

        const resolvedStatus = repository.getStatus(id) ?? status
        const events: TasksDomainEvent[] = [
          { kind: 'statusUpdated', payload: { status: resolvedStatus } }
        ]
        return { result: { success: true, status: resolvedStatus }, events }
      })
    },

    async deleteStatus(id: string) {
      return commit(() => {
        const status = repository.getStatus(id)
        repository.deleteStatus(id)
        const events: TasksDomainEvent[] = status
          ? [{ kind: 'statusDeleted', payload: { id, projectId: status.projectId } }]
          : []
        return { result: { success: true }, events }
      })
    },

    async reorderStatuses(statusIds: string[], positions: number[]) {
      return commit(() => {
        repository.reorderStatuses(statusIds, positions)
        const events: TasksDomainEvent[] = []
        for (const statusId of statusIds) {
          const status = repository.getStatus(statusId)
          if (status) {
            events.push({ kind: 'statusUpdated', payload: { status } })
          }
        }
        return { result: { success: true }, events }
      })
    },

    async bulkComplete(ids: string[]) {
      return commit(() => {
        // The bulk write is a single `UPDATE … WHERE id IN (…)`, so per-row
        // before-state costs one extra read per id. Accepted: the loop below
        // already reads each row once, and selections are user-sized.
        const before = new Map(ids.map((id) => [id, repository.getTask(id)]))
        const count = repository.bulkCompleteTasks(ids)
        const events: TasksDomainEvent[] = []
        for (const id of ids) {
          const task = repository.getTask(id)
          if (task) {
            events.push({
              kind: 'taskCompleted',
              payload: { id, task, previous: { completedAt: before.get(id)?.completedAt ?? null } }
            })
          }
        }
        return { result: { success: true, count }, events }
      })
    },

    async bulkDelete(ids: string[]) {
      return commit(() => {
        const snapshots = ids.map((id) => repository.getTask(id))
        const count = repository.bulkDeleteTasks(ids)
        const events = ids.map((id, index): TasksDomainEvent => ({
          kind: 'taskDeleted',
          payload: { id, snapshot: snapshots[index] }
        }))
        return { result: { success: true, count }, events }
      })
    },

    async bulkMove(ids: string[], projectId: string) {
      return commit(() => {
        const before = new Map(ids.map((id) => [id, repository.getTask(id)]))
        const count = repository.bulkMoveTasks(ids, projectId)
        const events: TasksDomainEvent[] = []
        for (const id of ids) {
          const task = repository.getTask(id)
          if (task) {
            events.push({
              kind: 'taskUpdated',
              payload: {
                id,
                task,
                changes: { projectId },
                changedFields: ['projectId', 'position'],
                previous: pickPrevious(before.get(id), ['projectId', 'position'])
              }
            })
          }
        }
        return { result: { success: true, count }, events }
      })
    },

    async bulkArchive(ids: string[]) {
      return commit(() => {
        const before = new Map(ids.map((id) => [id, repository.getTask(id)]))
        const count = repository.bulkArchiveTasks(ids)
        const events: TasksDomainEvent[] = []
        for (const id of ids) {
          const task = repository.getTask(id)
          if (task) {
            events.push({
              kind: 'taskUpdated',
              payload: {
                id,
                task,
                changes: { archivedAt: task.archivedAt },
                changedFields: ['archivedAt'],
                previous: { archivedAt: before.get(id)?.archivedAt ?? null }
              }
            })
          }
        }
        return { result: { success: true, count }, events }
      })
    }
  }
}
