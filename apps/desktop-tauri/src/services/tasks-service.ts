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
import { createInvokeForwarder, subscribeEvent } from '@/lib/ipc/forwarder'
import { createLogger } from '@/lib/logger'

export const tasksServiceLogger = createLogger('Tasks:Service')

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
export const tasksService: TasksClientAPI = createInvokeForwarder<TasksClientAPI>('tasks')

export function queueTaskReorder(ids: string[], positions: number[]): void {
  void tasksService.reorder(ids, positions).catch((error) => {
    tasksServiceLogger.error('Failed to reorder tasks:', error)
  })
}

export function onTaskCreated(callback: (event: TaskCreatedEvent) => void): () => void {
  return subscribeEvent<TaskCreatedEvent>('task-created', callback)
}

export function onTaskUpdated(callback: (event: TaskUpdatedEvent) => void): () => void {
  return subscribeEvent<TaskUpdatedEvent>('task-updated', callback)
}

export function onTaskDeleted(callback: (event: TaskDeletedEvent) => void): () => void {
  return subscribeEvent<TaskDeletedEvent>('task-deleted', callback)
}

export function onTaskCompleted(callback: (event: TaskCompletedEvent) => void): () => void {
  return subscribeEvent<TaskCompletedEvent>('task-completed', callback)
}

export function onTaskMoved(callback: (event: TaskMovedEvent) => void): () => void {
  return subscribeEvent<TaskMovedEvent>('task-moved', callback)
}

export function onProjectCreated(callback: (event: ProjectCreatedEvent) => void): () => void {
  return subscribeEvent<ProjectCreatedEvent>('project-created', callback)
}

export function onProjectUpdated(callback: (event: ProjectUpdatedEvent) => void): () => void {
  return subscribeEvent<ProjectUpdatedEvent>('project-updated', callback)
}

export function onProjectDeleted(callback: (event: ProjectDeletedEvent) => void): () => void {
  return subscribeEvent<ProjectDeletedEvent>('project-deleted', callback)
}
