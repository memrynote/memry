export interface TaskRecord {
  id: string
  projectId: string
  statusId: string | null
  parentId: string | null
  title: string
  description: string | null
  priority: number
  position: number
  dueDate: string | null
  dueTime: string | null
  durationMinutes: number | null
  startDate: string | null
  repeatConfig: unknown | null
  repeatFrom: string | null
  sourceNoteId: string | null
  completedAt: string | null
  archivedAt: string | null
  createdAt: string
  modifiedAt: string
  tags: string[]
  linkedNoteIds: string[]
  linkedCanvasIds: string[]
}

export interface ProjectRecord {
  id: string
  name: string
  description: string | null
  color: string
  icon: string | null
  position: number
  isInbox: boolean
  createdAt: string
  modifiedAt: string
  archivedAt: string | null
}

export interface StatusRecord {
  id: string
  projectId: string
  name: string
  color: string
  position: number
  isDefault: boolean
  isDone: boolean
  createdAt: string
}

export interface TaskTagRecord {
  tag: string
  count: number
}

export interface TaskStats {
  total: number
  completed: number
  archived: number
  overdue: number
  dueToday: number
}

export interface CreateTaskInput {
  title: string
  description?: string | null
  projectId?: string
  statusId?: string | null
  parentId?: string | null
  dueDate?: string | null
  dueTime?: string | null
  startDate?: string | null
  repeatConfig?: unknown | null
  repeatFrom?: string | null
  sourceNoteId?: string | null
  priority?: number
  tags?: string[]
  linkedNoteIds?: string[]
  linkedCanvasIds?: string[]
}

export interface MoveTaskInput {
  projectId?: string
  statusId?: string | null
  parentId?: string | null
  position?: number
}

export interface ListTasksOptions {
  projectId?: string
  statusId?: string | null
  parentId?: string | null
  includeCompleted?: boolean
  includeArchived?: boolean
  dueBefore?: string
  dueAfter?: string
  tags?: string[]
  search?: string
  sortBy?: 'modified' | 'created' | 'position' | 'priority' | 'dueDate'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface TasksService {
  create(input: CreateTaskInput): Promise<TaskRecord>
  get(id: string): Promise<TaskRecord | null>
  list(options?: ListTasksOptions): Promise<TaskRecord[]>
  update(id: string, updates: Partial<CreateTaskInput>): Promise<TaskRecord>
  complete(id: string): Promise<TaskRecord>
  reopen(id: string): Promise<TaskRecord>
  archive(id: string): Promise<TaskRecord>
  unarchive(id: string): Promise<TaskRecord>
  move(id: string, input: MoveTaskInput): Promise<TaskRecord>
  getSubtasks(parentId: string): Promise<TaskRecord[]>
  getLinkedTasks(noteId: string): Promise<TaskRecord[]>
  today(date?: string): Promise<TaskRecord[]>
  upcoming(options?: { days?: number; fromDate?: string }): Promise<TaskRecord[]>
  overdue(date?: string): Promise<TaskRecord[]>
  stats(date?: string): Promise<TaskStats>
  getTags(): Promise<TaskTagRecord[]>
  convertToSubtask(taskId: string, parentId: string): Promise<TaskRecord>
  convertToTask(id: string): Promise<TaskRecord>
  duplicate(id: string): Promise<TaskRecord>
  bulkComplete(ids: string[]): Promise<number>
  bulkArchive(ids: string[]): Promise<number>
  bulkMove(ids: string[], projectId: string): Promise<number>
  bulkDelete(ids: string[]): Promise<number>
  reorder(ids: string[], positions: number[]): Promise<boolean>
  delete(id: string): Promise<boolean>
  projects: {
    list(): Promise<ProjectRecord[]>
    get(id: string): Promise<ProjectRecord | null>
    create(input: {
      name: string
      description?: string | null
      color?: string
      icon?: string | null
    }): Promise<ProjectRecord>
    update(
      id: string,
      updates: { name?: string; description?: string | null; color?: string; icon?: string | null }
    ): Promise<ProjectRecord>
    archive(id: string): Promise<ProjectRecord>
    unarchive(id: string): Promise<ProjectRecord>
    delete(id: string): Promise<boolean>
    reorder(ids: string[], positions: number[]): Promise<boolean>
    statuses(projectId: string): Promise<StatusRecord[]>
    createStatus(
      projectId: string,
      input: { name: string; color?: string; isDone?: boolean }
    ): Promise<StatusRecord>
    updateStatus(
      id: string,
      updates: {
        name?: string
        color?: string
        position?: number
        isDefault?: boolean
        isDone?: boolean
      }
    ): Promise<StatusRecord | null>
    deleteStatus(id: string): Promise<boolean>
    reorderStatuses(ids: string[], positions: number[]): Promise<boolean>
  }
}
