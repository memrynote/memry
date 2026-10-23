import type {
  Project,
  ProjectLink,
  ProjectWithStatuses,
  Status,
  Task,
  TaskFieldValue,
  TaskFields
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
  durationMinutes?: number | null
  startDate?: string | null
  repeatConfig?: Task['repeatConfig']
  repeatFrom?: Task['repeatFrom']
  tags?: string[]
  linkedNoteIds?: string[]
  linkedCanvasIds?: string[]
  sourceNoteId?: string | null
  position?: number
  fields?: Record<string, TaskFieldValue>
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
  durationMinutes?: number | null
  startDate?: string | null
  repeatConfig?: Task['repeatConfig']
  repeatFrom?: Task['repeatFrom']
  tags?: string[]
  linkedNoteIds?: string[]
  linkedCanvasIds?: string[]
  fields?: Record<string, TaskFieldValue>
}

export interface TaskFieldsPatch {
  before: TaskFields
  after: TaskFields
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
      | 'fields'
      | 'hasSubtasks'
      | 'subtaskCount'
      | 'completedSubtaskCount'
    > &
      Pick<TaskCreateInput, 'fields'>
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
        | 'fields'
        | 'hasSubtasks'
        | 'subtaskCount'
        | 'completedSubtaskCount'
      >
    >
  ): Task | undefined
  patchTaskFields(
    taskId: string,
    patch: Record<string, TaskFieldValue>
  ): TaskFieldsPatch | undefined
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
  /**
   * Subtasks below the first level (the local `tasks.nestedSubtasks` setting,
   * on by default). Absent or false: the one-level rule older builds enforce. Sync applies
   * remote rows without these commands, so a deep task from another device
   * lands either way.
   */
  allowNestedSubtasks?: () => boolean
}

/** Runs a write in the unit of work, then publishes its events. */
export type TasksCommit = <W extends TasksWrite<unknown>>(write: () => W) => Promise<W['result']>
