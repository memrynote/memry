import { useCallback, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Project, ProjectWithStats, Status, Task } from '@memry/rpc/tasks'
import { formatDateKey } from '@/lib/task-utils'
import type { Task as UiTask, RepeatConfig as UiRepeatConfig } from '@/data/sample-tasks'
import type { Project as UiProject, Status as UiStatus, StatusType } from '@/data/tasks-data'
import {
  tasksService,
  onTaskCreated,
  onTaskUpdated,
  onTaskDeleted,
  onTaskCompleted,
  onProjectCreated,
  onProjectUpdated,
  onProjectDeleted
} from '@/services/tasks-service'
import { subscribeEvent } from '@/lib/ipc/forwarder'
import { createLogger } from '@/lib/logger'

const log = createLogger('Tasks:Queries')

const EMPTY_TASKS: UiTask[] = []
const EMPTY_PROJECTS: UiProject[] = []

const priorityMap: Record<number, UiTask['priority']> = {
  0: 'none',
  1: 'low',
  2: 'medium',
  3: 'high',
  4: 'urgent'
}

const priorityReverseMap: Record<UiTask['priority'], number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4
}

export const taskKeys = {
  all: ['task-workspace'] as const,
  tasks: () => [...taskKeys.all, 'tasks'] as const,
  projects: () => [...taskKeys.all, 'projects'] as const
}

function dbStatusToUiStatus(dbStatus: Status): UiStatus {
  let type: StatusType = 'todo'
  if (dbStatus.isDone) {
    type = 'done'
  } else if (dbStatus.isDefault) {
    type = dbStatus.position === 0 ? 'todo' : 'in_progress'
  } else {
    type = 'in_progress'
  }

  return {
    id: dbStatus.id,
    name: dbStatus.name,
    color: dbStatus.color,
    type,
    order: dbStatus.position
  }
}

function dbRepeatConfigToUiRepeatConfig(dbConfig: unknown): UiRepeatConfig | null {
  if (!dbConfig || typeof dbConfig !== 'object') return null

  const config = dbConfig as Record<string, unknown>
  if (!config.frequency || !config.endType) return null

  return {
    frequency: config.frequency as UiRepeatConfig['frequency'],
    interval: (config.interval as number) ?? 1,
    daysOfWeek: config.daysOfWeek as number[] | undefined,
    monthlyType: config.monthlyType as UiRepeatConfig['monthlyType'],
    dayOfMonth: config.dayOfMonth as number | undefined,
    weekOfMonth: config.weekOfMonth as number | undefined,
    dayOfWeekForMonth: config.dayOfWeekForMonth as number | undefined,
    endType: config.endType as UiRepeatConfig['endType'],
    endDate: config.endDate ? new Date(config.endDate as string) : null,
    endCount: config.endCount as number | undefined,
    completedCount: (config.completedCount as number) ?? 0,
    createdAt: config.createdAt ? new Date(config.createdAt as string) : new Date()
  }
}

function dbTaskToUiTask(dbTask: Task): UiTask {
  return {
    id: dbTask.id,
    title: dbTask.title,
    description: dbTask.description ?? '',
    projectId: dbTask.projectId,
    statusId: dbTask.statusId ?? '',
    priority: priorityMap[dbTask.priority as number] ?? 'none',
    dueDate: dbTask.dueDate ? new Date(dbTask.dueDate) : null,
    dueTime: dbTask.dueTime,
    isRepeating: !!dbTask.repeatConfig,
    repeatConfig: dbRepeatConfigToUiRepeatConfig(dbTask.repeatConfig),
    linkedNoteIds: dbTask.linkedNoteIds ?? [],
    sourceNoteId: dbTask.sourceNoteId ?? null,
    parentId: dbTask.parentId,
    subtaskIds: [],
    createdAt: new Date(dbTask.createdAt),
    completedAt: dbTask.completedAt ? new Date(dbTask.completedAt) : null,
    archivedAt: dbTask.archivedAt ? new Date(dbTask.archivedAt) : null
  }
}

function attachSubtaskIds(tasks: UiTask[]): UiTask[] {
  const subtasksByParent = new Map<string, UiTask[]>()

  for (const task of tasks) {
    if (!task.parentId) continue
    const existing = subtasksByParent.get(task.parentId) ?? []
    existing.push(task)
    subtasksByParent.set(task.parentId, existing)
  }

  return tasks.map((task) => {
    const subtasks = subtasksByParent.get(task.id)
    if (!subtasks || subtasks.length === 0) return task

    const sortedSubtaskIds = subtasks
      .slice()
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((subtask) => subtask.id)

    return {
      ...task,
      subtaskIds: sortedSubtaskIds
    }
  })
}

function dbProjectToUiProject(
  dbProject: Project | ProjectWithStats | (Project & { statuses: Status[] })
): UiProject {
  return {
    id: dbProject.id,
    name: dbProject.name,
    description: dbProject.description ?? '',
    icon: dbProject.icon ?? 'folder',
    color: dbProject.color,
    statuses:
      'statuses' in dbProject && Array.isArray(dbProject.statuses)
        ? dbProject.statuses.map(dbStatusToUiStatus)
        : [],
    isDefault: dbProject.isInbox,
    isArchived: !!dbProject.archivedAt,
    createdAt: new Date(dbProject.createdAt),
    taskCount: 'taskCount' in dbProject ? dbProject.taskCount : 0
  }
}

function toServiceRepeatConfig(config: UiRepeatConfig | null | undefined) {
  if (config === undefined) return undefined
  if (config === null) return null

  return {
    frequency: config.frequency,
    interval: config.interval,
    daysOfWeek: config.daysOfWeek,
    monthlyType: config.monthlyType,
    dayOfMonth: config.dayOfMonth,
    weekOfMonth: config.weekOfMonth,
    dayOfWeekForMonth: config.dayOfWeekForMonth,
    endType: config.endType,
    endDate: config.endDate ? formatDateKey(config.endDate) : null,
    endCount: config.endCount,
    completedCount: config.completedCount,
    createdAt: config.createdAt.toISOString()
  }
}

export function useTaskWorkspaceData({ enabled = true }: { enabled?: boolean }) {
  const queryClient = useQueryClient()

  const projectsQuery = useQuery({
    queryKey: taskKeys.projects(),
    enabled,
    queryFn: async (): Promise<UiProject[]> => {
      const projectsResponse = await tasksService.listProjects()
      const baseProjects = projectsResponse.projects.map(dbProjectToUiProject)

      return Promise.all(
        baseProjects.map(async (project) => {
          try {
            const statuses = await tasksService.listStatuses(project.id)
            return {
              ...project,
              statuses: statuses.map(dbStatusToUiStatus)
            }
          } catch (error) {
            log.warn(`Failed to load statuses for project ${project.id}:`, error)
            return project
          }
        })
      )
    }
  })

  const tasksQuery = useQuery({
    queryKey: taskKeys.tasks(),
    enabled,
    queryFn: async (): Promise<UiTask[]> => {
      const tasksResponse = await tasksService.list({
        includeCompleted: true,
        includeArchived: true,
        limit: 1000
      })

      return attachSubtaskIds(tasksResponse.tasks.map(dbTaskToUiTask))
    }
  })

  useEffect(() => {
    if (!enabled) return

    const invalidateTasks = (): void => {
      void queryClient.invalidateQueries({ queryKey: taskKeys.tasks() })
    }

    const invalidateProjects = (): void => {
      void queryClient.invalidateQueries({ queryKey: taskKeys.projects() })
    }

    const invalidateAll = (): void => {
      invalidateTasks()
      invalidateProjects()
    }

    const unsubscribeItemSynced = subscribeEvent<{ type: string }>('item-synced', (event) => {
      if (event.type === 'task') {
        invalidateTasks()
        return
      }

      if (event.type === 'project') {
        invalidateProjects()
      }
    })

    const unsubscribers = [
      onTaskCreated(invalidateAll),
      onTaskUpdated(invalidateAll),
      onTaskDeleted(invalidateAll),
      onTaskCompleted(invalidateAll),
      onProjectCreated(invalidateProjects),
      onProjectUpdated(invalidateProjects),
      onProjectDeleted(invalidateProjects),
      unsubscribeItemSynced
    ]

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe())
    }
  }, [enabled, queryClient])

  return {
    tasks: tasksQuery.data ?? EMPTY_TASKS,
    projects: projectsQuery.data ?? EMPTY_PROJECTS,
    isLoading: tasksQuery.isLoading || projectsQuery.isLoading,
    error: tasksQuery.error ?? projectsQuery.error ?? null,
    refetch: (): void => {
      void tasksQuery.refetch()
      void projectsQuery.refetch()
    }
  }
}

export function useTaskWorkspaceMutations() {
  const queryClient = useQueryClient()

  const setTasks = useCallback(
    (updater: UiTask[] | ((prev: UiTask[]) => UiTask[])) => {
      queryClient.setQueryData(taskKeys.tasks(), (previous: UiTask[] | undefined) => {
        const current = previous ?? []
        return typeof updater === 'function' ? updater(current) : updater
      })
    },
    [queryClient]
  )

  const setProjects = useCallback(
    (updater: UiProject[] | ((prev: UiProject[]) => UiProject[])) => {
      queryClient.setQueryData(taskKeys.projects(), (previous: UiProject[] | undefined) => {
        const current = previous ?? []
        return typeof updater === 'function' ? updater(current) : updater
      })
    },
    [queryClient]
  )

  const invalidateWorkspace = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: taskKeys.tasks() })
    void queryClient.invalidateQueries({ queryKey: taskKeys.projects() })
  }, [queryClient])

  const addTask = useCallback(
    async (task: UiTask) => {
      setTasks((prev) => [...prev, task])

      try {
        await tasksService.create({
          projectId: task.projectId,
          title: task.title,
          description: task.description || null,
          priority: priorityReverseMap[task.priority] ?? 0,
          statusId: task.statusId || null,
          parentId: task.parentId || null,
          dueDate: task.dueDate ? formatDateKey(task.dueDate) : null,
          dueTime: task.dueTime || null,
          isRepeating: task.isRepeating,
          repeatConfig: toServiceRepeatConfig(task.repeatConfig),
          repeatFrom: null,
          tags: [],
          linkedNoteIds: task.linkedNoteIds
        })
        invalidateWorkspace()
      } catch (error) {
        log.error('Failed to create task:', error)
      }
    },
    [invalidateWorkspace, setTasks]
  )

  const updateTask = useCallback(
    async (taskId: string, updates: Partial<UiTask>) => {
      setTasks((prev) => prev.map((task) => (task.id === taskId ? { ...task, ...updates } : task)))

      try {
        if ('completedAt' in updates) {
          if (updates.completedAt) {
            await tasksService.complete({
              id: taskId,
              completedAt: updates.completedAt.toISOString()
            })
          } else {
            await tasksService.uncomplete(taskId)
          }

          const { completedAt: _completedAt, ...otherUpdates } = updates
          void _completedAt

          if (Object.keys(otherUpdates).length > 0) {
            await tasksService.update({
              id: taskId,
              title: otherUpdates.title,
              description: otherUpdates.description ?? undefined,
              priority:
                otherUpdates.priority !== undefined
                  ? priorityReverseMap[otherUpdates.priority]
                  : undefined,
              projectId: otherUpdates.projectId,
              statusId: otherUpdates.statusId ?? undefined,
              parentId: otherUpdates.parentId ?? undefined,
              dueDate: otherUpdates.dueDate ? formatDateKey(otherUpdates.dueDate) : null,
              dueTime: otherUpdates.dueTime ?? undefined,
              isRepeating: otherUpdates.isRepeating,
              repeatConfig: toServiceRepeatConfig(otherUpdates.repeatConfig),
              linkedNoteIds: otherUpdates.linkedNoteIds
            })
          }

          invalidateWorkspace()
          return
        }

        if ('archivedAt' in updates) {
          if (updates.archivedAt) {
            await tasksService.archive(taskId)
          } else {
            await tasksService.unarchive(taskId)
          }

          const { archivedAt: _archivedAt, ...otherUpdates } = updates
          void _archivedAt

          if (Object.keys(otherUpdates).length > 0) {
            await tasksService.update({
              id: taskId,
              title: otherUpdates.title,
              description: otherUpdates.description ?? undefined,
              priority:
                otherUpdates.priority !== undefined
                  ? priorityReverseMap[otherUpdates.priority]
                  : undefined,
              projectId: otherUpdates.projectId,
              statusId: otherUpdates.statusId ?? undefined,
              parentId: otherUpdates.parentId ?? undefined,
              dueDate: otherUpdates.dueDate ? formatDateKey(otherUpdates.dueDate) : null,
              dueTime: otherUpdates.dueTime ?? undefined,
              isRepeating: otherUpdates.isRepeating,
              repeatConfig: toServiceRepeatConfig(otherUpdates.repeatConfig),
              linkedNoteIds: otherUpdates.linkedNoteIds
            })
          }

          invalidateWorkspace()
          return
        }

        await tasksService.update({
          id: taskId,
          title: updates.title,
          description: updates.description ?? undefined,
          priority:
            updates.priority !== undefined ? priorityReverseMap[updates.priority] : undefined,
          projectId: updates.projectId,
          statusId: updates.statusId ?? undefined,
          parentId: updates.parentId ?? undefined,
          dueDate: updates.dueDate ? formatDateKey(updates.dueDate) : null,
          dueTime: updates.dueTime ?? undefined,
          isRepeating: updates.isRepeating,
          repeatConfig: toServiceRepeatConfig(updates.repeatConfig),
          linkedNoteIds: updates.linkedNoteIds
        })

        invalidateWorkspace()
      } catch (error) {
        log.error('Failed to update task:', error)
      }
    },
    [invalidateWorkspace, setTasks]
  )

  const deleteTask = useCallback(
    async (taskId: string) => {
      setTasks((prev) => prev.filter((task) => task.id !== taskId))

      try {
        await tasksService.delete(taskId)
        invalidateWorkspace()
      } catch (error) {
        log.error('Failed to delete task:', error)
      }
    },
    [invalidateWorkspace, setTasks]
  )

  const addProject = useCallback(
    async (project: UiProject) => {
      setProjects((prev) => [...prev, project])

      try {
        await tasksService.createProject({
          name: project.name,
          description: project.description || null,
          color: project.color,
          icon: project.icon || null,
          statuses:
            project.statuses.length >= 2
              ? project.statuses.map((status) => ({
                  name: status.name,
                  color: status.color,
                  type: status.type,
                  order: status.order
                }))
              : undefined
        })
        invalidateWorkspace()
      } catch (error) {
        log.error('Failed to create project:', error)
      }
    },
    [invalidateWorkspace, setProjects]
  )

  const updateProject = useCallback(
    async (projectId: string, updates: Partial<UiProject>) => {
      setProjects((prev) =>
        prev.map((project) => (project.id === projectId ? { ...project, ...updates } : project))
      )

      try {
        await tasksService.updateProject({
          id: projectId,
          name: updates.name,
          description: updates.description ?? undefined,
          color: updates.color,
          icon: updates.icon ?? undefined,
          statuses: updates.statuses?.map((status) => ({
            id: status.id,
            name: status.name,
            color: status.color,
            type: status.type,
            order: status.order
          }))
        })
        invalidateWorkspace()
      } catch (error) {
        log.error('Failed to update project:', error)
      }
    },
    [invalidateWorkspace, setProjects]
  )

  const deleteProject = useCallback(
    async (projectId: string) => {
      setProjects((prev) => prev.filter((project) => project.id !== projectId))

      try {
        await tasksService.deleteProject(projectId)
        invalidateWorkspace()
      } catch (error) {
        log.error('Failed to delete project:', error)
      }
    },
    [invalidateWorkspace, setProjects]
  )

  return {
    setTasks,
    setProjects,
    addTask,
    updateTask,
    deleteTask,
    addProject,
    updateProject,
    deleteProject
  }
}
