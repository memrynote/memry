import type {
  ProjectCreatedEvent,
  ProjectDeletedEvent,
  ProjectListResponse,
  ProjectUpdatedEvent,
  ProjectWithStatuses,
  Task,
  TaskCompletedEvent,
  TaskCreatedEvent,
  TaskDeletedEvent,
  TaskListItem,
  TaskMovedEvent,
  TasksClientAPI,
  TaskUpdatedEvent
} from '@memry/rpc/tasks'
import type {
  Project,
  ProjectCreateInput,
  ProjectUpdateInput,
  ProjectWithStats,
  RepeatConfig,
  Status,
  StatusCreateInput,
  TaskCreateInput,
  TaskCreateResponse,
  TaskListInput as TaskListOptions,
  TaskListResponse,
  TaskMoveInput,
  TaskStats,
  TaskUpdateInput
} from '@memry/contracts/tasks-api'

export type {
  Project,
  ProjectCreateInput,
  ProjectListResponse,
  ProjectUpdateInput,
  ProjectWithStats,
  ProjectWithStatuses,
  RepeatConfig,
  Status,
  StatusCreateInput,
  Task,
  TaskCompletedEvent,
  TaskCreateInput,
  TaskCreateResponse,
  TaskCreatedEvent,
  TaskDeletedEvent,
  TaskListItem,
  TaskListOptions,
  TaskListResponse,
  TaskMovedEvent,
  TaskMoveInput,
  TaskStats,
  TasksClientAPI,
  TaskUpdatedEvent,
  TaskUpdateInput
}

export const tasksService: TasksClientAPI = {
  create: (input) => window.api.tasks.create(input),
  get: (id) => window.api.tasks.get(id),
  update: (input) => window.api.tasks.update(input),
  delete: (id) => window.api.tasks.delete(id),
  list: (options) => window.api.tasks.list(options),
  complete: (input) => window.api.tasks.complete(input),
  uncomplete: (id) => window.api.tasks.uncomplete(id),
  archive: (id) => window.api.tasks.archive(id),
  unarchive: (id) => window.api.tasks.unarchive(id),
  move: (input) => window.api.tasks.move(input),
  reorder: (taskIds, positions) => window.api.tasks.reorder(taskIds, positions),
  duplicate: (id) => window.api.tasks.duplicate(id),
  getSubtasks: (parentId) => window.api.tasks.getSubtasks(parentId),
  convertToSubtask: (taskId, parentId) => window.api.tasks.convertToSubtask(taskId, parentId),
  convertToTask: (taskId) => window.api.tasks.convertToTask(taskId),
  createProject: (input) => window.api.tasks.createProject(input),
  getProject: (id) => window.api.tasks.getProject(id),
  updateProject: (input) => window.api.tasks.updateProject(input),
  deleteProject: (id) => window.api.tasks.deleteProject(id),
  listProjects: () => window.api.tasks.listProjects(),
  archiveProject: (id) => window.api.tasks.archiveProject(id),
  reorderProjects: (projectIds, positions) => window.api.tasks.reorderProjects(projectIds, positions),
  createStatus: (input) => window.api.tasks.createStatus(input),
  updateStatus: (id, updates) => window.api.tasks.updateStatus(id, updates),
  deleteStatus: (id) => window.api.tasks.deleteStatus(id),
  reorderStatuses: (statusIds, positions) => window.api.tasks.reorderStatuses(statusIds, positions),
  listStatuses: (projectId) => window.api.tasks.listStatuses(projectId),
  getTags: () => window.api.tasks.getTags(),
  bulkComplete: (ids) => window.api.tasks.bulkComplete(ids),
  bulkDelete: (ids) => window.api.tasks.bulkDelete(ids),
  bulkMove: (ids, projectId) => window.api.tasks.bulkMove(ids, projectId),
  bulkArchive: (ids) => window.api.tasks.bulkArchive(ids),
  getStats: () => window.api.tasks.getStats(),
  getToday: () => window.api.tasks.getToday(),
  getUpcoming: (days) => window.api.tasks.getUpcoming(days),
  getOverdue: () => window.api.tasks.getOverdue(),
  getLinkedTasks: (noteId) => window.api.tasks.getLinkedTasks(noteId),
  seedPerformanceTest: () => window.api.tasks.seedPerformanceTest(),
  seedDemo: () => window.api.tasks.seedDemo()
}

export function onTaskCreated(callback: (event: TaskCreatedEvent) => void): () => void {
  return window.api.onTaskCreated(callback)
}

export function onTaskUpdated(callback: (event: TaskUpdatedEvent) => void): () => void {
  return window.api.onTaskUpdated(callback)
}

export function onTaskDeleted(callback: (event: TaskDeletedEvent) => void): () => void {
  return window.api.onTaskDeleted(callback)
}

export function onTaskCompleted(callback: (event: TaskCompletedEvent) => void): () => void {
  return window.api.onTaskCompleted(callback)
}

export function onTaskMoved(callback: (event: TaskMovedEvent) => void): () => void {
  return window.api.onTaskMoved(callback)
}

export function onProjectCreated(callback: (event: ProjectCreatedEvent) => void): () => void {
  return window.api.onProjectCreated(callback)
}

export function onProjectUpdated(callback: (event: ProjectUpdatedEvent) => void): () => void {
  return window.api.onProjectUpdated(callback)
}

export function onProjectDeleted(callback: (event: ProjectDeletedEvent) => void): () => void {
  return window.api.onProjectDeleted(callback)
}
