import type {
  Project,
  ProjectContents,
  ProjectLink,
  ProjectRef,
  ProjectWithStats,
  ProjectWithStatuses,
  Status,
  Task,
  TaskListItem,
  TaskListOptions,
  TaskStats
} from '@memry/domain-tasks'

type TaskRecord = Omit<Task, 'isRepeating' | 'priority' | 'repeatConfig' | 'repeatFrom'> & {
  priority: number
  repeatConfig: unknown
  repeatFrom: string | null
}
type ProjectRecord = Project
type StatusRecord = Status
type ProjectLinkRecord = ProjectLink

export interface TaskQueryModule<TDb> {
  insertTask(db: TDb, task: Record<string, unknown>): TaskRecord
  updateTask(db: TDb, id: string, updates: Record<string, unknown>): TaskRecord | undefined
  deleteTask(db: TDb, id: string): void
  getTaskById(db: TDb, id: string): TaskRecord | undefined
  listTasks(db: TDb, options?: TaskListOptions): TaskRecord[]
  countTasks(
    db: TDb,
    options?: Pick<TaskListOptions, 'projectId' | 'includeCompleted' | 'includeArchived'>
  ): number
  getSubtasks(db: TDb, parentId: string): TaskRecord[]
  countSubtasks(db: TDb, parentId: string): { total: number; completed: number }
  completeTask(db: TDb, id: string, completedAt?: string): TaskRecord | undefined
  uncompleteTask(db: TDb, id: string): TaskRecord | undefined
  archiveTask(db: TDb, id: string): TaskRecord | undefined
  unarchiveTask(db: TDb, id: string): TaskRecord | undefined
  moveTask(
    db: TDb,
    id: string,
    updates: {
      projectId?: string
      statusId?: string | null
      parentId?: string | null
      position?: number
    }
  ): TaskRecord | undefined
  reorderTasks(db: TDb, taskIds: string[], positions: number[]): void
  duplicateTask(db: TDb, id: string, newId: string): TaskRecord | undefined
  duplicateSubtask(db: TDb, id: string, newId: string, newParentId: string): TaskRecord | undefined
  setTaskTags(db: TDb, taskId: string, tags: string[]): void
  getTaskTags(db: TDb, taskId: string): string[]
  setTaskNotes(db: TDb, taskId: string, noteIds: string[]): void
  getTaskNoteIds(db: TDb, taskId: string): string[]
  setTaskCanvases(db: TDb, taskId: string, canvasIds: string[]): void
  getTaskCanvasIds(db: TDb, taskId: string): string[]
  getAllTaskTags(db: TDb): { tag: string; count: number }[]
  getTaskStats(db: TDb): TaskStats
  getTodayTasks(db: TDb): TaskRecord[]
  getUpcomingTasks(db: TDb, days?: number): TaskRecord[]
  getOverdueTasks(db: TDb): TaskRecord[]
  getTasksLinkedToNote(db: TDb, noteId: string): TaskRecord[]
  getNextTaskPosition(db: TDb, projectId: string, parentId?: string | null): number
  bulkCompleteTasks(db: TDb, ids: string[]): number
  bulkDeleteTasks(db: TDb, ids: string[]): number
  bulkMoveTasks(db: TDb, ids: string[], projectId: string): number
  bulkArchiveTasks(db: TDb, ids: string[]): number
}

export interface ProjectQueryModule<TDb> {
  insertProject(db: TDb, project: Record<string, unknown>): ProjectRecord
  updateProject(db: TDb, id: string, updates: Record<string, unknown>): ProjectRecord | undefined
  deleteProject(db: TDb, id: string): void
  getProjectWithStatuses(db: TDb, id: string): ProjectWithStatuses | undefined
  getProjectsWithStats(db: TDb): ProjectWithStats[]
  archiveProject(db: TDb, id: string): ProjectRecord | undefined
  reorderProjects(db: TDb, projectIds: string[], positions: number[]): void
  getNextProjectPosition(db: TDb): number
  insertStatus(db: TDb, status: Record<string, unknown>): StatusRecord
  updateStatus(db: TDb, id: string, updates: Record<string, unknown>): StatusRecord | undefined
  deleteStatus(db: TDb, id: string): void
  getStatusesByProject(db: TDb, projectId: string): StatusRecord[]
  reorderStatuses(db: TDb, statusIds: string[], positions: number[]): void
  getNextStatusPosition(db: TDb, projectId: string): number
  getStatusById(db: TDb, id: string): StatusRecord | undefined
  getEquivalentStatus(
    db: TDb,
    targetProjectId: string,
    sourceStatus?: StatusRecord
  ): StatusRecord | undefined
  createDefaultStatuses(db: TDb, projectId: string): StatusRecord[]
  createCustomStatuses(
    db: TDb,
    projectId: string,
    inputs: Array<{
      name: string
      color: string
      type: 'todo' | 'in_progress' | 'done'
      order: number
    }>
  ): StatusRecord[]
  reconcileProjectStatuses(
    db: TDb,
    projectId: string,
    inputs: Array<{
      id?: string
      name: string
      color: string
      type: 'todo' | 'in_progress' | 'done'
      order: number
    }>
  ): void
  insertProjectLink(
    db: TDb,
    link: { id: string; projectId: string; itemType: string; itemId: string }
  ): ProjectLinkRecord
  deleteProjectLink(db: TDb, projectId: string, itemType: string, itemId: string): void
  getProjectContents(db: TDb, projectId: string): ProjectContents
  setProjectLinkPinned(db: TDb, projectId: string, itemId: string, pinned: boolean): void
  getProjectLink(
    db: TDb,
    projectId: string,
    itemType: string,
    itemId: string
  ): ProjectLinkRecord | undefined
  getProjectLinks(db: TDb, projectId: string): ProjectLinkRecord[]
  updateProjectHomeNote(db: TDb, projectId: string, noteId: string | null): void
  getProjectsForItem(db: TDb, itemType: string, itemId: string): ProjectRef[]
  deleteProjectLinksForItem(db: TDb, itemType: string, itemId: string): string[]
  clearProjectsHomeNote(db: TDb, noteId: string): string[]
}

export interface CreateTasksRepositoryDeps<TDb> {
  db: TDb
  taskQueries: TaskQueryModule<TDb>
  projectQueries: ProjectQueryModule<TDb>
}

function enrichTask<TDb>(db: TDb, taskQueries: TaskQueryModule<TDb>, task: TaskRecord): Task {
  const subtaskCounts = taskQueries.countSubtasks(db, task.id)
  return {
    ...task,
    priority: task.priority as Task['priority'],
    repeatConfig: task.repeatConfig as Task['repeatConfig'],
    repeatFrom: task.repeatFrom as Task['repeatFrom'],
    isRepeating: !!task.repeatConfig,
    tags: taskQueries.getTaskTags(db, task.id),
    linkedNoteIds: taskQueries.getTaskNoteIds(db, task.id),
    linkedCanvasIds: taskQueries.getTaskCanvasIds(db, task.id),
    hasSubtasks: subtaskCounts.total > 0,
    subtaskCount: subtaskCounts.total,
    completedSubtaskCount: subtaskCounts.completed
  }
}

/**
 * Drop the sync bookkeeping columns from a listed row (#1326).
 *
 * `clock`, `fieldClocks` and `syncedAt` are not part of the declared `Task`
 * shape — they only reach callers because `enrichTask` spreads the raw database
 * row — and nothing that consumes `tasks:list` reads them. `fieldClocks` alone
 * is a device-id-keyed vector clock per syncable field, which on a synced vault
 * is the single largest part of a task row. The app-root workspace fetch pulls
 * up to 1000 rows and re-runs on every task create / update / delete / complete
 * and every incoming task sync event, so this is the payload worth cutting.
 *
 * Deliberately NOT done inside `enrichTask`: `getTask` feeds the delete
 * snapshot that `task-sync.ts`'s `buildDeletePayload` hands to
 * `withIncrementedClock`, which reads `clock` back off it. Stripping there
 * would reset every task tombstone's vector clock to a fresh one.
 */
function stripSyncBookkeeping(task: Task): TaskListItem {
  const {
    clock: _clock,
    fieldClocks: _fieldClocks,
    syncedAt: _syncedAt,
    ...rest
  } = task as Task & { clock?: unknown; fieldClocks?: unknown; syncedAt?: unknown }

  return rest as TaskListItem
}

export function createTasksRepository<TDb>({
  db,
  taskQueries,
  projectQueries
}: CreateTasksRepositoryDeps<TDb>) {
  return {
    getTask(id: string): Task | undefined {
      const task = taskQueries.getTaskById(db, id)
      return task ? enrichTask(db, taskQueries, task) : undefined
    },

    createTask(
      task: Omit<
        Task,
        | 'isRepeating'
        | 'tags'
        | 'linkedNoteIds'
        | 'linkedCanvasIds'
        | 'hasSubtasks'
        | 'subtaskCount'
        | 'completedSubtaskCount'
      >
    ): Task {
      const created = taskQueries.insertTask(db, task)
      return enrichTask(db, taskQueries, created)
    },

    updateTask(id: string, updates: Record<string, unknown>): Task | undefined {
      const task = taskQueries.updateTask(db, id, updates)
      return task ? enrichTask(db, taskQueries, task) : undefined
    },

    deleteTask(id: string): void {
      taskQueries.deleteTask(db, id)
    },

    listTasks(options: TaskListOptions = {}): TaskListItem[] {
      return taskQueries
        .listTasks(db, options)
        .map((task) => stripSyncBookkeeping(enrichTask(db, taskQueries, task)))
    },

    countTasks(
      options?: Pick<TaskListOptions, 'projectId' | 'includeCompleted' | 'includeArchived'>
    ): number {
      return taskQueries.countTasks(db, options)
    },

    getSubtasks(parentId: string): Task[] {
      return taskQueries.getSubtasks(db, parentId).map((task) => enrichTask(db, taskQueries, task))
    },

    countSubtasks(parentId: string) {
      return taskQueries.countSubtasks(db, parentId)
    },

    completeTask(id: string, completedAt?: string): Task | undefined {
      const task = taskQueries.completeTask(db, id, completedAt)
      return task ? enrichTask(db, taskQueries, task) : undefined
    },

    uncompleteTask(id: string): Task | undefined {
      const task = taskQueries.uncompleteTask(db, id)
      return task ? enrichTask(db, taskQueries, task) : undefined
    },

    archiveTask(id: string): Task | undefined {
      const task = taskQueries.archiveTask(db, id)
      return task ? enrichTask(db, taskQueries, task) : undefined
    },

    unarchiveTask(id: string): Task | undefined {
      const task = taskQueries.unarchiveTask(db, id)
      return task ? enrichTask(db, taskQueries, task) : undefined
    },

    moveTask(
      id: string,
      updates: {
        projectId?: string
        statusId?: string | null
        parentId?: string | null
        position?: number
      }
    ): Task | undefined {
      const task = taskQueries.moveTask(db, id, updates)
      return task ? enrichTask(db, taskQueries, task) : undefined
    },

    reorderTasks(taskIds: string[], positions: number[]): void {
      taskQueries.reorderTasks(db, taskIds, positions)
    },

    duplicateTask(id: string, newId: string): Task | undefined {
      const task = taskQueries.duplicateTask(db, id, newId)
      return task ? enrichTask(db, taskQueries, task) : undefined
    },

    duplicateSubtask(id: string, newId: string, newParentId: string): Task | undefined {
      const task = taskQueries.duplicateSubtask(db, id, newId, newParentId)
      return task ? enrichTask(db, taskQueries, task) : undefined
    },

    getTaskTags(taskId: string): string[] {
      return taskQueries.getTaskTags(db, taskId)
    },

    setTaskTags(taskId: string, tags: string[]): void {
      taskQueries.setTaskTags(db, taskId, tags)
    },

    getTaskNoteIds(taskId: string): string[] {
      return taskQueries.getTaskNoteIds(db, taskId)
    },

    getTaskCanvasIds(taskId: string): string[] {
      return taskQueries.getTaskCanvasIds(db, taskId)
    },

    setTaskCanvases(taskId: string, canvasIds: string[]): void {
      taskQueries.setTaskCanvases(db, taskId, canvasIds)
    },

    setTaskNotes(taskId: string, noteIds: string[]): void {
      taskQueries.setTaskNotes(db, taskId, noteIds)
    },

    getAllTaskTags(): { tag: string; count: number }[] {
      return taskQueries.getAllTaskTags(db)
    },

    getTaskStats(): TaskStats {
      return taskQueries.getTaskStats(db)
    },

    getTodayTasks(): Task[] {
      return taskQueries.getTodayTasks(db).map((task) => enrichTask(db, taskQueries, task))
    },

    getUpcomingTasks(days?: number): Task[] {
      return taskQueries.getUpcomingTasks(db, days).map((task) => enrichTask(db, taskQueries, task))
    },

    getOverdueTasks(): Task[] {
      return taskQueries.getOverdueTasks(db).map((task) => enrichTask(db, taskQueries, task))
    },

    getTasksLinkedToNote(noteId: string): Task[] {
      return taskQueries
        .getTasksLinkedToNote(db, noteId)
        .map((task) => enrichTask(db, taskQueries, task))
    },

    getNextTaskPosition(projectId: string, parentId?: string | null): number {
      return taskQueries.getNextTaskPosition(db, projectId, parentId)
    },

    createProject(project: Omit<Project, 'createdAt' | 'modifiedAt' | 'archivedAt'>): Project {
      return projectQueries.insertProject(db, project)
    },

    updateProject(id: string, updates: Record<string, unknown>): Project | undefined {
      return projectQueries.updateProject(db, id, updates)
    },

    deleteProject(id: string): void {
      projectQueries.deleteProject(db, id)
    },

    getProject(projectId: string): ProjectWithStatuses | undefined {
      return projectQueries.getProjectWithStatuses(db, projectId)
    },

    listProjects(): ProjectWithStats[] {
      return projectQueries.getProjectsWithStats(db)
    },

    archiveProject(id: string): Project | undefined {
      return projectQueries.archiveProject(db, id)
    },

    reorderProjects(projectIds: string[], positions: number[]): void {
      projectQueries.reorderProjects(db, projectIds, positions)
    },

    getNextProjectPosition(): number {
      return projectQueries.getNextProjectPosition(db)
    },

    createDefaultStatuses(projectId: string): Status[] {
      return projectQueries.createDefaultStatuses(db, projectId)
    },

    createCustomStatuses(
      projectId: string,
      statuses: Array<{
        name: string
        color: string
        type: 'todo' | 'in_progress' | 'done'
        order: number
      }>
    ): Status[] {
      return projectQueries.createCustomStatuses(db, projectId, statuses)
    },

    reconcileProjectStatuses(
      projectId: string,
      statuses: Array<{
        id?: string
        name: string
        color: string
        type: 'todo' | 'in_progress' | 'done'
        order: number
      }>
    ): void {
      projectQueries.reconcileProjectStatuses(db, projectId, statuses)
    },

    linkItemToProject(link: {
      id: string
      projectId: string
      itemType: string
      itemId: string
    }): ProjectLink {
      return projectQueries.insertProjectLink(db, link)
    },

    unlinkItemFromProject(projectId: string, itemType: string, itemId: string): void {
      projectQueries.deleteProjectLink(db, projectId, itemType, itemId)
    },

    findProjectLink(projectId: string, itemType: string, itemId: string): ProjectLink | undefined {
      return projectQueries.getProjectLink(db, projectId, itemType, itemId)
    },

    listProjectLinks(projectId: string): ProjectLink[] {
      return projectQueries.getProjectLinks(db, projectId)
    },

    listProjectContents(projectId: string): ProjectContents {
      return projectQueries.getProjectContents(db, projectId)
    },

    setProjectLinkPinned(projectId: string, itemId: string, pinned: boolean): void {
      projectQueries.setProjectLinkPinned(db, projectId, itemId, pinned)
    },

    setProjectHomeNote(projectId: string, noteId: string | null): void {
      projectQueries.updateProjectHomeNote(db, projectId, noteId)
    },

    listForItem(itemType: string, itemId: string): ProjectRef[] {
      return projectQueries.getProjectsForItem(db, itemType, itemId)
    },

    deleteProjectLinksForItem(itemType: string, itemId: string): string[] {
      return projectQueries.deleteProjectLinksForItem(db, itemType, itemId)
    },

    clearProjectsHomeNote(noteId: string): string[] {
      return projectQueries.clearProjectsHomeNote(db, noteId)
    },

    getStatus(id: string): Status | undefined {
      return projectQueries.getStatusById(db, id)
    },

    listStatuses(projectId: string): Status[] {
      return projectQueries.getStatusesByProject(db, projectId)
    },

    createStatus(status: Omit<Status, 'createdAt'>): Status {
      return projectQueries.insertStatus(db, status)
    },

    updateStatus(id: string, updates: Record<string, unknown>): Status | undefined {
      return projectQueries.updateStatus(db, id, updates)
    },

    deleteStatus(id: string): void {
      projectQueries.deleteStatus(db, id)
    },

    reorderStatuses(statusIds: string[], positions: number[]): void {
      projectQueries.reorderStatuses(db, statusIds, positions)
    },

    getNextStatusPosition(projectId: string): number {
      return projectQueries.getNextStatusPosition(db, projectId)
    },

    getEquivalentStatus(targetProjectId: string, sourceStatus?: Status): Status | undefined {
      return projectQueries.getEquivalentStatus(db, targetProjectId, sourceStatus)
    },

    bulkCompleteTasks(ids: string[]): number {
      return taskQueries.bulkCompleteTasks(db, ids)
    },

    bulkDeleteTasks(ids: string[]): number {
      return taskQueries.bulkDeleteTasks(db, ids)
    },

    bulkMoveTasks(ids: string[], projectId: string): number {
      return taskQueries.bulkMoveTasks(db, ids, projectId)
    },

    bulkArchiveTasks(ids: string[]): number {
      return taskQueries.bulkArchiveTasks(db, ids)
    }
  }
}
