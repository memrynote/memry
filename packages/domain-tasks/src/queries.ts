import type {
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
} from './types.ts'

export interface TasksQueryRepository {
  getTask(id: string): Task | undefined
  listTasks(options?: TaskListOptions): TaskListItem[]
  countTasks(
    options?: Pick<TaskListOptions, 'projectId' | 'includeCompleted' | 'includeArchived'>
  ): number
  getSubtasks(parentId: string): Task[]
  listProjects(): ProjectWithStats[]
  getProject(projectId: string): ProjectWithStatuses | undefined
  listStatuses(projectId: string): Status[]
  listProjectLinks(projectId: string): ProjectLink[]
  listProjectContents(projectId: string): ProjectContents
  getAllTaskTags(): { tag: string; count: number }[]
  getTaskStats(): TaskStats
  getTodayTasks(): Task[]
  getUpcomingTasks(days?: number): Task[]
  getOverdueTasks(): Task[]
  getTasksLinkedToNote(noteId: string): Task[]
  listForItem(itemType: string, itemId: string): ProjectRef[]
}

export interface TaskListResult {
  tasks: TaskListItem[]
  total: number
  hasMore: boolean
}

export interface TaskListEnvelope {
  tasks: Task[]
  total: number
  hasMore: boolean
}

export function createTasksQueries(repository: TasksQueryRepository) {
  return {
    getTask(id: string): Task | null {
      return repository.getTask(id) ?? null
    },

    listTasks(options: TaskListOptions = {}): TaskListResult {
      const tasks = repository.listTasks(options)
      const total = repository.countTasks({
        projectId: options.projectId,
        includeCompleted: options.includeCompleted,
        includeArchived: options.includeArchived
      })

      return {
        tasks,
        total,
        hasMore: (options.offset ?? 0) + tasks.length < total
      }
    },

    getSubtasks(parentId: string): Task[] {
      return repository.getSubtasks(parentId)
    },

    getProject(projectId: string): ProjectWithStatuses | undefined {
      return repository.getProject(projectId)
    },

    listProjects(): { projects: ProjectWithStats[] } {
      return {
        projects: repository.listProjects()
      }
    },

    listStatuses(projectId: string): Status[] {
      return repository.listStatuses(projectId)
    },

    listProjectLinks(projectId: string): ProjectLink[] {
      return repository.listProjectLinks(projectId)
    },

    listProjectContents(projectId: string): ProjectContents {
      return repository.listProjectContents(projectId)
    },

    getTags(): { tag: string; count: number }[] {
      return repository.getAllTaskTags()
    },

    getStats(): TaskStats {
      return repository.getTaskStats()
    },

    getToday(): TaskListEnvelope {
      const tasks = repository.getTodayTasks()
      return { tasks, total: tasks.length, hasMore: false }
    },

    getUpcoming(days?: number): TaskListEnvelope {
      const tasks = repository.getUpcomingTasks(days)
      return { tasks, total: tasks.length, hasMore: false }
    },

    getOverdue(): TaskListEnvelope {
      const tasks = repository.getOverdueTasks()
      return { tasks, total: tasks.length, hasMore: false }
    },

    getLinkedTasks(noteId: string): Task[] {
      return repository.getTasksLinkedToNote(noteId)
    },

    listForItem(itemType: string, itemId: string): ProjectRef[] {
      return repository.listForItem(itemType, itemId)
    }
  }
}
