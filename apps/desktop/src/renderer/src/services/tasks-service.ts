/**
 * Tasks service client.
 * Thin wrapper around window.api.tasks for type-safe access.
 *
 * @module services/tasks-service
 */

import type {
  RepeatConfig,
  Task,
  TaskListItem,
  Project,
  ProjectWithStats,
  ProjectWithStatuses,
  Status,
  TaskStats
} from '@memry/contracts/tasks-api'

export type {
  RepeatConfig,
  Task,
  TaskListItem,
  Project,
  ProjectWithStats,
  ProjectWithStatuses,
  Status,
  TaskStats
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
  isRepeating?: boolean
  repeatConfig?: RepeatConfig | null
  repeatFrom?: 'due' | 'completion' | null
  tags?: string[]
  linkedNoteIds?: string[]
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
  isRepeating?: boolean
  repeatConfig?: RepeatConfig | null
  repeatFrom?: 'due' | 'completion' | null
  tags?: string[]
  linkedNoteIds?: string[]
}

export interface TaskListOptions {
  projectId?: string
  statusId?: string | null
  parentId?: string | null
  includeCompleted?: boolean
  includeArchived?: boolean
  dueBefore?: string
  dueAfter?: string
  tags?: string[]
  search?: string
  sortBy?: 'position' | 'dueDate' | 'priority' | 'created' | 'modified'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface TaskCreateResponse {
  success: boolean
  task: Task | null
  error?: string
}

export interface TaskListResponse {
  tasks: TaskListItem[]
  total: number
  hasMore: boolean
}

export interface ProjectCreateInput {
  name: string
  description?: string | null
  color?: string
  icon?: string | null
  statuses?: Array<{
    name: string
    color: string
    type: 'todo' | 'in_progress' | 'done'
    order: number
  }>
}

export interface ProjectUpdateInput {
  id: string
  name?: string
  description?: string | null
  color?: string
  icon?: string | null
  statuses?: Array<{
    id?: string
    name: string
    color: string
    type: 'todo' | 'in_progress' | 'done'
    order: number
  }>
}

export interface ProjectListResponse {
  projects: ProjectWithStats[]
}

export interface StatusCreateInput {
  projectId: string
  name: string
  color?: string
  isDone?: boolean
}

export interface TaskMoveInput {
  taskId: string
  targetProjectId?: string
  targetStatusId?: string | null
  targetParentId?: string | null
  position: number
}

export interface TaskCreatedEvent {
  task: Task
}

export interface TaskUpdatedEvent {
  id: string
  task: Task
  changes: Partial<Task>
}

export interface TaskDeletedEvent {
  id: string
}

export interface TaskCompletedEvent {
  id: string
  task: Task
}

export interface TaskMovedEvent {
  id: string
  task: Task
}

export interface ProjectCreatedEvent {
  project: Project
}

export interface ProjectUpdatedEvent {
  id: string
  project: Project
}

export interface ProjectDeletedEvent {
  id: string
}

export interface TasksClientAPI {
  create(input: TaskCreateInput): Promise<TaskCreateResponse>
  get(id: string): Promise<Task | null>
  update(input: TaskUpdateInput): Promise<TaskCreateResponse>
  delete(id: string): Promise<{ success: boolean; error?: string }>
  list(options?: TaskListOptions): Promise<TaskListResponse>

  complete(input: { id: string; completedAt?: string }): Promise<TaskCreateResponse>
  uncomplete(id: string): Promise<TaskCreateResponse>
  archive(id: string): Promise<{ success: boolean; error?: string }>
  unarchive(id: string): Promise<{ success: boolean; error?: string }>
  move(input: TaskMoveInput): Promise<TaskCreateResponse>
  reorder(taskIds: string[], positions: number[]): Promise<{ success: boolean; error?: string }>
  duplicate(id: string): Promise<TaskCreateResponse>

  getSubtasks(parentId: string): Promise<Task[]>
  convertToSubtask(taskId: string, parentId: string): Promise<TaskCreateResponse>
  convertToTask(taskId: string): Promise<TaskCreateResponse>

  createProject(
    input: ProjectCreateInput
  ): Promise<{ success: boolean; project: Project | null; error?: string }>
  getProject(id: string): Promise<ProjectWithStatuses | null>
  updateProject(
    input: ProjectUpdateInput
  ): Promise<{ success: boolean; project: Project | null; error?: string }>
  deleteProject(id: string): Promise<{ success: boolean; error?: string }>
  listProjects(): Promise<ProjectListResponse>
  archiveProject(id: string): Promise<{ success: boolean; error?: string }>
  reorderProjects(
    projectIds: string[],
    positions: number[]
  ): Promise<{ success: boolean; error?: string }>

  createStatus(
    input: StatusCreateInput
  ): Promise<{ success: boolean; status: Status | null; error?: string }>
  updateStatus(id: string, updates: Partial<Status>): Promise<{ success: boolean; error?: string }>
  deleteStatus(id: string): Promise<{ success: boolean; error?: string }>
  reorderStatuses(
    statusIds: string[],
    positions: number[]
  ): Promise<{ success: boolean; error?: string }>
  listStatuses(projectId: string): Promise<Status[]>

  getTags(): Promise<{ tag: string; count: number }[]>

  bulkComplete(ids: string[]): Promise<{ success: boolean; count: number; error?: string }>
  bulkDelete(ids: string[]): Promise<{ success: boolean; count: number; error?: string }>
  bulkMove(
    ids: string[],
    projectId: string
  ): Promise<{ success: boolean; count: number; error?: string }>
  bulkArchive(ids: string[]): Promise<{ success: boolean; count: number; error?: string }>

  getStats(): Promise<TaskStats>
  getToday(): Promise<TaskListResponse>
  getUpcoming(days?: number): Promise<TaskListResponse>
  getOverdue(): Promise<TaskListResponse>

  // Note linking
  getLinkedTasks(noteId: string): Promise<Task[]>

  // Development/Testing
  seedPerformanceTest(): Promise<{ success: boolean; message: string }>
}

/**
 * Tasks service - wraps window.api.tasks with type safety.
 */
export const tasksService: TasksClientAPI = {
  // Task CRUD
  create: (input: TaskCreateInput) => window.api.tasks.create(input),
  get: (id: string) => window.api.tasks.get(id),
  update: (input: TaskUpdateInput) => window.api.tasks.update(input),
  delete: (id: string) => window.api.tasks.delete(id),
  list: (options?: TaskListOptions) => window.api.tasks.list(options),

  // Task actions
  complete: (input: { id: string; completedAt?: string }) => window.api.tasks.complete(input),
  uncomplete: (id: string) => window.api.tasks.uncomplete(id),
  archive: (id: string) => window.api.tasks.archive(id),
  unarchive: (id: string) => window.api.tasks.unarchive(id),
  move: (input: TaskMoveInput) => window.api.tasks.move(input),
  reorder: (taskIds: string[], positions: number[]) => window.api.tasks.reorder(taskIds, positions),
  duplicate: (id: string) => window.api.tasks.duplicate(id),

  // Subtask operations
  getSubtasks: (parentId: string) => window.api.tasks.getSubtasks(parentId),
  convertToSubtask: (taskId: string, parentId: string) =>
    window.api.tasks.convertToSubtask(taskId, parentId),
  convertToTask: (taskId: string) => window.api.tasks.convertToTask(taskId),

  // Project operations
  createProject: (input: ProjectCreateInput) => window.api.tasks.createProject(input),
  getProject: (id: string) => window.api.tasks.getProject(id),
  updateProject: (input: ProjectUpdateInput) => window.api.tasks.updateProject(input),
  deleteProject: (id: string) => window.api.tasks.deleteProject(id),
  listProjects: () => window.api.tasks.listProjects(),
  archiveProject: (id: string) => window.api.tasks.archiveProject(id),
  reorderProjects: (projectIds: string[], positions: number[]) =>
    window.api.tasks.reorderProjects(projectIds, positions),

  // Status operations
  createStatus: (input: StatusCreateInput) => window.api.tasks.createStatus(input),
  updateStatus: (id: string, updates: Partial<Status>) =>
    window.api.tasks.updateStatus(id, updates),
  deleteStatus: (id: string) => window.api.tasks.deleteStatus(id),
  reorderStatuses: (statusIds: string[], positions: number[]) =>
    window.api.tasks.reorderStatuses(statusIds, positions),
  listStatuses: (projectId: string) => window.api.tasks.listStatuses(projectId),

  // Tag operations
  getTags: () => window.api.tasks.getTags(),

  // Bulk operations
  bulkComplete: (ids: string[]) => window.api.tasks.bulkComplete(ids),
  bulkDelete: (ids: string[]) => window.api.tasks.bulkDelete(ids),
  bulkMove: (ids: string[], projectId: string) => window.api.tasks.bulkMove(ids, projectId),
  bulkArchive: (ids: string[]) => window.api.tasks.bulkArchive(ids),

  // Stats and views
  getStats: () => window.api.tasks.getStats(),
  getToday: () => window.api.tasks.getToday(),
  getUpcoming: (days?: number) => window.api.tasks.getUpcoming(days),
  getOverdue: () => window.api.tasks.getOverdue(),

  // Note linking
  getLinkedTasks: (noteId: string) => window.api.tasks.getLinkedTasks(noteId),

  // Development/Testing
  seedPerformanceTest: () => window.api.tasks.seedPerformanceTest()
}

// ============================================================================
// Event subscription helpers
// ============================================================================

/**
 * Subscribe to task created events.
 * Returns an unsubscribe function.
 */
export function onTaskCreated(callback: (event: TaskCreatedEvent) => void): () => void {
  return window.api.onTaskCreated(callback)
}

/**
 * Subscribe to task updated events.
 * Returns an unsubscribe function.
 */
export function onTaskUpdated(callback: (event: TaskUpdatedEvent) => void): () => void {
  return window.api.onTaskUpdated(callback)
}

/**
 * Subscribe to task deleted events.
 * Returns an unsubscribe function.
 */
export function onTaskDeleted(callback: (event: TaskDeletedEvent) => void): () => void {
  return window.api.onTaskDeleted(callback)
}

/**
 * Subscribe to task completed events.
 * Returns an unsubscribe function.
 */
export function onTaskCompleted(callback: (event: TaskCompletedEvent) => void): () => void {
  return window.api.onTaskCompleted(callback)
}

/**
 * Subscribe to task moved events.
 * Returns an unsubscribe function.
 */
export function onTaskMoved(callback: (event: TaskMovedEvent) => void): () => void {
  return window.api.onTaskMoved(callback)
}

/**
 * Subscribe to project created events.
 * Returns an unsubscribe function.
 */
export function onProjectCreated(callback: (event: ProjectCreatedEvent) => void): () => void {
  return window.api.onProjectCreated(callback)
}

/**
 * Subscribe to project updated events.
 * Returns an unsubscribe function.
 */
export function onProjectUpdated(callback: (event: ProjectUpdatedEvent) => void): () => void {
  return window.api.onProjectUpdated(callback)
}

/**
 * Subscribe to project deleted events.
 * Returns an unsubscribe function.
 */
export function onProjectDeleted(callback: (event: ProjectDeletedEvent) => void): () => void {
  return window.api.onProjectDeleted(callback)
}

// Types are already exported with their interface/type definitions above
