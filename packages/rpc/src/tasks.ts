import { z } from 'zod'
import { TasksChannels } from '@memry/contracts/ipc-channels'
import {
  ProjectCreateSchema,
  ProjectUpdateSchema,
  StatusCreateSchema,
  TaskCreateSchema,
  TaskListSchema,
  TaskUpdateSchema
} from '@memry/contracts/tasks-api'
import type {
  Project,
  ProjectWithStats,
  RepeatConfig,
  Status,
  TaskCreateResponse,
  TaskMoveInput,
  TaskStats,
} from '@memry/contracts/tasks-api'
import { defineDomain, defineEvent, defineMethod, type RpcClient, type RpcSubscriptions } from './schema.ts'

export type ProjectCreateInput = z.input<typeof ProjectCreateSchema>
export type ProjectUpdateInput = z.input<typeof ProjectUpdateSchema>
export type StatusCreateInput = z.input<typeof StatusCreateSchema>
export type TaskCreateInput = z.input<typeof TaskCreateSchema>
export type TaskUpdateInput = z.input<typeof TaskUpdateSchema>
export type TaskListOptions = z.input<typeof TaskListSchema>

export type { Project, ProjectWithStats, RepeatConfig, Status, TaskCreateResponse, TaskMoveInput, TaskStats }

export interface Task {
  id: string
  projectId: string
  statusId: string | null
  parentId: string | null
  title: string
  description: string | null
  priority: 0 | 1 | 2 | 3 | 4
  position: number
  dueDate: string | null
  dueTime: string | null
  startDate: string | null
  repeatConfig: RepeatConfig | null
  repeatFrom: 'due' | 'completion' | null
  sourceNoteId: string | null
  completedAt: string | null
  archivedAt: string | null
  createdAt: string
  modifiedAt: string
  tags?: string[]
  linkedNoteIds?: string[]
  hasSubtasks?: boolean
  subtaskCount?: number
  completedSubtaskCount?: number
}

export type TaskListItem = Task

export interface TaskViewResponse {
  tasks: Task[]
  total: number
  hasMore: boolean
}

export type TaskListResponse = TaskViewResponse

export interface ProjectWithStatuses extends Project {
  statuses: Status[]
}

export interface ProjectListResponse {
  projects: ProjectWithStats[]
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

type TaskMutationResponse = Promise<TaskCreateResponse>
type StatusMutationResponse = Promise<{ success: boolean; status: Status | null; error?: string }>
type ProjectMutationResponse = Promise<{ success: boolean; project: Project | null; error?: string }>
type SuccessResponse = Promise<{ success: boolean; error?: string }>
type BulkResponse = Promise<{ success: boolean; count: number; error?: string }>

export const tasksRpc = defineDomain({
  name: 'tasks',
  methods: {
    create: defineMethod<(input: TaskCreateInput) => Promise<TaskCreateResponse>>({
      channel: TasksChannels.invoke.CREATE,
      params: ['input']
    }),
    get: defineMethod<(id: string) => Promise<Task | null>>({
      channel: TasksChannels.invoke.GET,
      params: ['id']
    }),
    update: defineMethod<(input: TaskUpdateInput) => Promise<TaskCreateResponse>>({
      channel: TasksChannels.invoke.UPDATE,
      params: ['input']
    }),
    delete: defineMethod<(id: string) => SuccessResponse>({
      channel: TasksChannels.invoke.DELETE,
      params: ['id']
    }),
    list: defineMethod<(options?: TaskListOptions) => Promise<TaskListResponse>>({
      channel: TasksChannels.invoke.LIST,
      params: ['options'],
      invokeArgs: ['options ?? {}']
    }),
    complete: defineMethod<(input: { id: string; completedAt?: string }) => TaskMutationResponse>({
      channel: TasksChannels.invoke.COMPLETE,
      params: ['input']
    }),
    uncomplete: defineMethod<(id: string) => TaskMutationResponse>({
      channel: TasksChannels.invoke.UNCOMPLETE,
      params: ['id']
    }),
    archive: defineMethod<(id: string) => SuccessResponse>({
      channel: TasksChannels.invoke.ARCHIVE,
      params: ['id']
    }),
    unarchive: defineMethod<(id: string) => SuccessResponse>({
      channel: TasksChannels.invoke.UNARCHIVE,
      params: ['id']
    }),
    move: defineMethod<(input: TaskMoveInput) => TaskMutationResponse>({
      channel: TasksChannels.invoke.MOVE,
      params: ['input']
    }),
    reorder: defineMethod<(taskIds: string[], positions: number[]) => SuccessResponse>({
      channel: TasksChannels.invoke.REORDER,
      params: ['taskIds', 'positions'],
      invokeArgs: ['{ taskIds, positions }']
    }),
    duplicate: defineMethod<(id: string) => TaskMutationResponse>({
      channel: TasksChannels.invoke.DUPLICATE,
      params: ['id']
    }),
    getSubtasks: defineMethod<(parentId: string) => Promise<Task[]>>({
      channel: TasksChannels.invoke.GET_SUBTASKS,
      params: ['parentId']
    }),
    convertToSubtask: defineMethod<(taskId: string, parentId: string) => TaskMutationResponse>({
      channel: TasksChannels.invoke.CONVERT_TO_SUBTASK,
      params: ['taskId', 'parentId'],
      invokeArgs: ['{ taskId, parentId }']
    }),
    convertToTask: defineMethod<(taskId: string) => TaskMutationResponse>({
      channel: TasksChannels.invoke.CONVERT_TO_TASK,
      params: ['taskId']
    }),
    createProject: defineMethod<(input: ProjectCreateInput) => ProjectMutationResponse>({
      channel: TasksChannels.invoke.PROJECT_CREATE,
      params: ['input']
    }),
    getProject: defineMethod<(id: string) => Promise<ProjectWithStatuses | null>>({
      channel: TasksChannels.invoke.PROJECT_GET,
      params: ['id']
    }),
    updateProject: defineMethod<(input: ProjectUpdateInput) => ProjectMutationResponse>({
      channel: TasksChannels.invoke.PROJECT_UPDATE,
      params: ['input']
    }),
    deleteProject: defineMethod<(id: string) => SuccessResponse>({
      channel: TasksChannels.invoke.PROJECT_DELETE,
      params: ['id']
    }),
    listProjects: defineMethod<() => Promise<ProjectListResponse>>({
      channel: TasksChannels.invoke.PROJECT_LIST
    }),
    archiveProject: defineMethod<(id: string) => SuccessResponse>({
      channel: TasksChannels.invoke.PROJECT_ARCHIVE,
      params: ['id']
    }),
    reorderProjects: defineMethod<(projectIds: string[], positions: number[]) => SuccessResponse>({
      channel: TasksChannels.invoke.PROJECT_REORDER,
      params: ['projectIds', 'positions'],
      invokeArgs: ['{ projectIds, positions }']
    }),
    createStatus: defineMethod<(input: StatusCreateInput) => StatusMutationResponse>({
      channel: TasksChannels.invoke.STATUS_CREATE,
      params: ['input']
    }),
    updateStatus: defineMethod<(id: string, updates: Partial<Status>) => SuccessResponse>({
      channel: TasksChannels.invoke.STATUS_UPDATE,
      params: ['id', 'updates'],
      invokeArgs: ['{ id, ...updates }']
    }),
    deleteStatus: defineMethod<(id: string) => SuccessResponse>({
      channel: TasksChannels.invoke.STATUS_DELETE,
      params: ['id']
    }),
    reorderStatuses: defineMethod<(statusIds: string[], positions: number[]) => SuccessResponse>({
      channel: TasksChannels.invoke.STATUS_REORDER,
      params: ['statusIds', 'positions'],
      invokeArgs: ['{ statusIds, positions }']
    }),
    listStatuses: defineMethod<(projectId: string) => Promise<Status[]>>({
      channel: TasksChannels.invoke.STATUS_LIST,
      params: ['projectId']
    }),
    getTags: defineMethod<() => Promise<Array<{ tag: string; count: number }>>>({
      channel: TasksChannels.invoke.GET_TAGS
    }),
    bulkComplete: defineMethod<(ids: string[]) => BulkResponse>({
      channel: TasksChannels.invoke.BULK_COMPLETE,
      params: ['ids'],
      invokeArgs: ['{ ids }']
    }),
    bulkDelete: defineMethod<(ids: string[]) => BulkResponse>({
      channel: TasksChannels.invoke.BULK_DELETE,
      params: ['ids'],
      invokeArgs: ['{ ids }']
    }),
    bulkMove: defineMethod<(ids: string[], projectId: string) => BulkResponse>({
      channel: TasksChannels.invoke.BULK_MOVE,
      params: ['ids', 'projectId'],
      invokeArgs: ['{ ids, projectId }']
    }),
    bulkArchive: defineMethod<(ids: string[]) => BulkResponse>({
      channel: TasksChannels.invoke.BULK_ARCHIVE,
      params: ['ids'],
      invokeArgs: ['{ ids }']
    }),
    getStats: defineMethod<() => Promise<TaskStats>>({
      channel: TasksChannels.invoke.GET_STATS
    }),
    getToday: defineMethod<() => Promise<TaskViewResponse>>({
      channel: TasksChannels.invoke.GET_TODAY
    }),
    getUpcoming: defineMethod<(days?: number) => Promise<TaskViewResponse>>({
      channel: TasksChannels.invoke.GET_UPCOMING,
      params: ['days'],
      invokeArgs: ['{ days: days ?? 7 }']
    }),
    getOverdue: defineMethod<() => Promise<TaskViewResponse>>({
      channel: TasksChannels.invoke.GET_OVERDUE
    }),
    getLinkedTasks: defineMethod<(noteId: string) => Promise<Task[]>>({
      channel: TasksChannels.invoke.GET_LINKED_TASKS,
      params: ['noteId']
    }),
    seedPerformanceTest: defineMethod<() => Promise<{ success: boolean; message: string }>>({
      channel: 'tasks:seed-performance-test'
    }),
    seedDemo: defineMethod<() => Promise<{ success: boolean; message: string }>>({
      channel: 'tasks:seed-demo'
    })
  },
  events: {
    onTaskCreated: defineEvent<TaskCreatedEvent>(TasksChannels.events.CREATED),
    onTaskUpdated: defineEvent<TaskUpdatedEvent>(TasksChannels.events.UPDATED),
    onTaskDeleted: defineEvent<TaskDeletedEvent>(TasksChannels.events.DELETED),
    onTaskCompleted: defineEvent<TaskCompletedEvent>(TasksChannels.events.COMPLETED),
    onTaskMoved: defineEvent<TaskMovedEvent>(TasksChannels.events.MOVED),
    onProjectCreated: defineEvent<ProjectCreatedEvent>(TasksChannels.events.PROJECT_CREATED),
    onProjectUpdated: defineEvent<ProjectUpdatedEvent>(TasksChannels.events.PROJECT_UPDATED),
    onProjectDeleted: defineEvent<ProjectDeletedEvent>(TasksChannels.events.PROJECT_DELETED)
  }
})

export type TasksClientAPI = RpcClient<typeof tasksRpc>
export type TasksSubscriptions = RpcSubscriptions<typeof tasksRpc>
