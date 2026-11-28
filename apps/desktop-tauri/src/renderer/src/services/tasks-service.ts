import type {
  Project,
  ProjectCreateInput,
  ProjectCreatedEvent,
  ProjectDeletedEvent,
  ProjectItemType,
  ProjectLink,
  ProjectLinkItemInput,
  ProjectListResponse,
  ProjectRef,
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
import {
  commands,
  events,
  type BulkMutation,
  type ProjectMutation,
  type ProjectWithStatusesView,
  type StatusMutation,
  type TaskAck,
  type TaskListItemView,
  type TaskMutation,
  type TaskView
} from '../../../generated/bindings'
import { createWindowApiForwarder } from './window-api-forwarder'
import { subscribeToEvent } from './tauri-event'
import { createLogger } from '@/lib/logger'

export const tasksServiceLogger = createLogger('Tasks:Service')

export type {
  Project,
  ProjectCreateInput,
  ProjectItemType,
  ProjectLink,
  ProjectLinkItemInput,
  ProjectListResponse,
  ProjectRef,
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
/** Electron's `Task` (rpc's, and domain-tasks' of the write envelopes): the row's columns. */
type TaskRow = Task & NonNullable<TaskCreateResponse['task']>

function toTask(view: TaskView | TaskListItemView): TaskRow {
  return {
    ...view,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- carried verbatim from the row; its writers constrain it to the union
    priority: view.priority as TaskRow['priority'],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- carried verbatim from the row; its writers store a RepeatConfig
    repeatConfig: view.repeatConfig as TaskRow['repeatConfig'],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- carried verbatim from the row; its writers constrain it to the union
    repeatFrom: view.repeatFrom as TaskRow['repeatFrom'],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- carried verbatim from the row; its writers store no null field value
    fields: view.fields as TaskRow['fields']
  }
}

function toProject(view: ProjectWithStatusesView): ProjectWithStatuses {
  return view
}

/** An envelope's `error`, dropped when the command sent none. */
function refusal(error: string | null | undefined): { error?: string } {
  return error ? { error } : {}
}

async function taskWrite(write: Promise<TaskMutation>): Promise<TaskCreateResponse> {
  const result = await write
  return {
    success: result.success,
    task: result.task ? toTask(result.task) : null,
    ...refusal(result.error)
  }
}

async function acknowledged(
  write: Promise<TaskAck | ProjectMutation | StatusMutation>
): Promise<{ success: boolean; error?: string }> {
  const result = await write
  return { success: result.success, ...refusal(result.error) }
}

async function projectWrite(
  write: Promise<ProjectMutation>
): Promise<{ success: boolean; project: Project | null; error?: string }> {
  const result = await write
  return {
    success: result.success,
    project: result.project ? toProject(result.project) : null,
    ...refusal(result.error)
  }
}

async function bulk(
  write: Promise<BulkMutation>
): Promise<{ success: boolean; count: number; error?: string }> {
  const result = await write
  return { success: result.success, count: result.count, ...refusal(result.error) }
}

/** Electron's `{ tasks, total, hasMore }` of the dated views, which answer every match. */
function envelope(views: TaskListItemView[]): TaskListResponse {
  const tasks = views.map(toTask)
  return { tasks, total: tasks.length, hasMore: false }
}

/**
 * The task commands of Step 21e (`commands/tasks.rs`, `task_writes`, `task_projects`) in the
 * shapes of Electron's `tasks:*` channels. A refusal answers in the `{ success, error }` envelope;
 * a failed bound or storage failure rejects, as each command does. `captureUrlToProject` and
 * `importFilesToProject` have no command yet and still reach `window.api.tasks`.
 */
const ported: Omit<TasksClientAPI, 'captureUrlToProject' | 'importFilesToProject'> = {
  create: (input) => taskWrite(commands.tasksCreate(input)),
  get: async (id) => {
    const view = await commands.tasksGet(id)
    return view ? toTask(view) : null
  },
  update: (input) => taskWrite(commands.tasksUpdate(input)),
  delete: (id) => acknowledged(commands.tasksDelete(id)),
  list: async (options) => {
    const page = await commands.tasksList(options ?? {})
    return { tasks: page.tasks.map(toTask), total: page.total, hasMore: page.hasMore }
  },
  complete: async (input) => {
    const result = await commands.tasksComplete(input)
    const next = result.nextOccurrence
    return {
      success: result.success,
      task: result.task ? toTask(result.task) : null,
      nextOccurrence: next?.dueDate ? { id: next.id, dueDate: next.dueDate } : null,
      ...refusal(result.error)
    }
  },
  uncomplete: (id) => taskWrite(commands.tasksUncomplete(id)),
  archive: (id) => acknowledged(commands.tasksArchive(id)),
  unarchive: (id) => acknowledged(commands.tasksUnarchive(id)),
  move: (input) => taskWrite(commands.tasksMove(input)),
  reorder: (taskIds, positions) => acknowledged(commands.tasksReorder({ taskIds, positions })),
  duplicate: (id) => taskWrite(commands.tasksDuplicate(id)),
  getSubtasks: async (parentId) => (await commands.tasksGetSubtasks(parentId)).map(toTask),
  convertToSubtask: (taskId, parentId) =>
    taskWrite(commands.tasksConvertToSubtask({ taskId, parentId })),
  convertToTask: (taskId) => taskWrite(commands.tasksConvertToTask(taskId)),
  createProject: (input) => projectWrite(commands.tasksProjectCreate(input)),
  getProject: async (id) => {
    const view = await commands.tasksProjectGet(id)
    return view ? toProject(view) : null
  },
  updateProject: (input) => projectWrite(commands.tasksProjectUpdate(input)),
  deleteProject: (id) => acknowledged(commands.tasksProjectDelete(id)),
  listProjects: () => commands.tasksProjectList(),
  archiveProject: (id) => acknowledged(commands.tasksProjectArchive(id)),
  reorderProjects: (projectIds, positions) =>
    acknowledged(commands.tasksProjectReorder({ projectIds, positions })),
  linkProjectItem: (input) => acknowledged(commands.tasksProjectLinkItem(input)),
  unlinkProjectItem: (input) => acknowledged(commands.tasksProjectUnlinkItem(input)),
  listProjectLinks: (projectId) => commands.tasksProjectListLinks(projectId),
  listProjectContents: (projectId) => commands.tasksProjectListContents(projectId),
  setProjectLinkPinned: (input) => projectWrite(commands.tasksProjectSetLinkPinned(input)),
  setProjectHomeNote: (input) => projectWrite(commands.tasksProjectSetHomeNote(input)),
  listForItem: (itemType, itemId) => commands.tasksProjectListForItem({ itemType, itemId }),
  createStatus: async (input) => {
    const result = await commands.tasksStatusCreate(input)
    return { success: result.success, status: result.status ?? null, ...refusal(result.error) }
  },
  updateStatus: (id, updates) => acknowledged(commands.tasksStatusUpdate({ ...updates, id })),
  deleteStatus: (id) => acknowledged(commands.tasksStatusDelete(id)),
  reorderStatuses: (statusIds, positions) =>
    acknowledged(commands.tasksStatusReorder({ statusIds, positions })),
  listStatuses: (projectId) => commands.tasksStatusList(projectId),
  getTags: () => commands.tasksGetTags(),
  bulkComplete: (ids) => bulk(commands.tasksBulkComplete({ ids })),
  bulkDelete: (ids) => bulk(commands.tasksBulkDelete({ ids })),
  bulkMove: (ids, projectId) => bulk(commands.tasksBulkMove({ ids, projectId })),
  bulkArchive: (ids) => bulk(commands.tasksBulkArchive({ ids })),
  getStats: () => commands.tasksGetStats(),
  getToday: async () => envelope(await commands.tasksGetToday()),
  getUpcoming: async (days) => envelope(await commands.tasksGetUpcoming(days ?? 7)),
  getOverdue: async () => envelope(await commands.tasksGetOverdue()),
  getLinkedTasks: async (noteId) => (await commands.tasksGetLinkedTasks(noteId)).map(toTask),
  getActivity: (input) => commands.tasksGetActivity(input)
}

export const tasksService: TasksClientAPI = createWindowApiForwarder<
  TasksClientAPI,
  keyof typeof ported
>(() => window.api.tasks, ported)

export function queueTaskReorder(ids: string[], positions: number[]): void {
  void tasksService.reorder(ids, positions).then(
    (result) => {
      if (!result.success) tasksServiceLogger.error('Failed to reorder tasks:', result.error)
    },
    (error: unknown) => {
      tasksServiceLogger.error('Failed to reorder tasks:', error)
    }
  )
}

type IdEvent = {
  listen: (handler: (event: { payload: { id: string } }) => void) => Promise<() => void>
}

/**
 * `callback` with Electron's payload for each event: the Rust events carry the id, and the
 * record is read back by it. A record gone by then is not delivered, as nothing is left to show.
 */
function subscribeReadBack<R, P>(
  event: IdEvent,
  read: (id: string) => Promise<R | null>,
  payload: (id: string, record: R) => P,
  callback: (payload: P) => void
): () => void {
  let active = true
  const deliver = async (id: string): Promise<void> => {
    try {
      const record = await read(id)
      if (active && record) callback(payload(id, record))
    } catch (error) {
      tasksServiceLogger.warn('could not read back the record of an event', error)
    }
  }
  const unsubscribe = subscribeToEvent(event, ({ id }) => void deliver(id))
  return () => {
    active = false
    unsubscribe()
  }
}

const readTask = (id: string): Promise<Task | null> => ported.get(id)
const readProject = (id: string): Promise<Project | null> => ported.getProject(id)

/** `changes` is empty: the Rust event names the task, and `task` holds every new value. */
export function onTaskCreated(callback: (event: TaskCreatedEvent) => void): () => void {
  return subscribeReadBack(events.taskCreatedEvent, readTask, (_id, task) => ({ task }), callback)
}

export function onTaskUpdated(callback: (event: TaskUpdatedEvent) => void): () => void {
  return subscribeReadBack(
    events.taskUpdatedEvent,
    readTask,
    (id, task) => ({ id, task, changes: {} }),
    callback
  )
}

export function onTaskDeleted(callback: (event: TaskDeletedEvent) => void): () => void {
  return subscribeToEvent(events.taskDeletedEvent, ({ id }) => callback({ id }))
}

export function onTaskCompleted(callback: (event: TaskCompletedEvent) => void): () => void {
  return subscribeReadBack(
    events.taskCompletedEvent,
    readTask,
    (id, task) => ({ id, task }),
    callback
  )
}

export function onTaskMoved(callback: (event: TaskMovedEvent) => void): () => void {
  return subscribeReadBack(events.taskMovedEvent, readTask, (id, task) => ({ id, task }), callback)
}

export function onTaskActivityCreated(callback: (event: { taskId: string }) => void): () => void {
  return subscribeToEvent(events.taskActivityCreatedEvent, ({ taskId }) => callback({ taskId }))
}

export function onProjectCreated(callback: (event: ProjectCreatedEvent) => void): () => void {
  return subscribeReadBack(
    events.projectCreatedEvent,
    readProject,
    (_id, project) => ({ project }),
    callback
  )
}

export function onProjectUpdated(callback: (event: ProjectUpdatedEvent) => void): () => void {
  return subscribeReadBack(
    events.projectUpdatedEvent,
    readProject,
    (id, project) => ({ id, project }),
    callback
  )
}

export function onProjectDeleted(callback: (event: ProjectDeletedEvent) => void): () => void {
  return subscribeToEvent(events.projectDeletedEvent, ({ id }) => callback({ id }))
}
