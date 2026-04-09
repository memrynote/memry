import type {
  Project,
  ProjectCreateInput,
  ProjectCreatedEvent,
  ProjectDeletedEvent,
  ProjectListResponse,
  ProjectUpdateInput,
  ProjectUpdatedEvent,
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
} from '@memry/rpc/tasks'
import { createWindowApiForwarder } from './window-api-forwarder'

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
export const tasksService: TasksClientAPI = createWindowApiForwarder(() => window.api.tasks)

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
