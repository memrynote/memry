/**
 * Tasks Context
 * Provides task and project state across the application
 * Enables split view panes to access shared task data
 *
 * Integrates with the database via IPC when a vault is open.
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
  type ReactNode
} from 'react'
import type { Task, RepeatConfig } from '@/data/sample-tasks'
import type { Project, Status, StatusType } from '@/data/tasks-data'
import type { TaskSelectionType } from '@/App'
import {
  tasksService,
  onTaskCreated,
  onTaskUpdated,
  onTaskDeleted,
  onProjectCreated,
  onProjectUpdated,
  onProjectDeleted,
  type Task as DbTask,
  type Project as DbProject,
  type ProjectWithStats,
  type Status as DbStatus
} from '@/services/tasks-service'
import { useVault } from '@/hooks/use-vault'

// =============================================================================
// TYPE CONVERSION HELPERS
// =============================================================================

const priorityMap: Record<number, Task['priority']> = {
  0: 'none',
  1: 'low',
  2: 'medium',
  3: 'high',
  4: 'urgent' // T006: Added urgent priority level
}

const priorityReverseMap: Record<Task['priority'], number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4 // T006: Map urgent to level 4
}

/**
 * Convert database status to UI status format
 * T004: Added for loading statuses per project
 */
function dbStatusToUiStatus(dbStatus: DbStatus): Status {
  // Map isDone to status type
  let type: StatusType = 'todo'
  if (dbStatus.isDone) {
    type = 'done'
  } else if (dbStatus.isDefault) {
    // Default non-done status is typically "in_progress" or "todo"
    // Using position to infer - first status is usually todo
    type = dbStatus.position === 0 ? 'todo' : 'in_progress'
  } else {
    // Non-default, non-done status
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

/**
 * Convert database repeatConfig JSON to UI RepeatConfig format
 * T005: Implement repeatConfig conversion
 */
function dbRepeatConfigToUiRepeatConfig(dbConfig: unknown): RepeatConfig | null {
  if (!dbConfig || typeof dbConfig !== 'object') return null

  const config = dbConfig as Record<string, unknown>

  // Validate required fields
  if (!config.frequency || !config.endType) return null

  return {
    frequency: config.frequency as RepeatConfig['frequency'],
    interval: (config.interval as number) ?? 1,
    daysOfWeek: config.daysOfWeek as number[] | undefined,
    monthlyType: config.monthlyType as RepeatConfig['monthlyType'],
    dayOfMonth: config.dayOfMonth as number | undefined,
    weekOfMonth: config.weekOfMonth as number | undefined,
    dayOfWeekForMonth: config.dayOfWeekForMonth as number | undefined,
    endType: config.endType as RepeatConfig['endType'],
    endDate: config.endDate ? new Date(config.endDate as string) : null,
    endCount: config.endCount as number | undefined,
    completedCount: (config.completedCount as number) ?? 0,
    createdAt: config.createdAt ? new Date(config.createdAt as string) : new Date()
  }
}

/**
 * Convert database task to UI task format
 */
function dbTaskToUiTask(dbTask: DbTask): Task {
  // T005: Convert repeatConfig from JSON to UI format
  const repeatConfig = dbRepeatConfigToUiRepeatConfig(dbTask.repeatConfig)

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
    repeatConfig, // T005: Now properly converted
    linkedNoteIds: dbTask.linkedNoteIds ?? [],
    sourceNoteId: null,
    parentId: dbTask.parentId,
    subtaskIds: [], // T007: Loaded separately via getSubtasks
    createdAt: new Date(dbTask.createdAt),
    completedAt: dbTask.completedAt ? new Date(dbTask.completedAt) : null,
    archivedAt: dbTask.archivedAt ? new Date(dbTask.archivedAt) : null
  }
}

/**
 * Convert database project to UI project format
 */
function dbProjectToUiProject(dbProject: DbProject | ProjectWithStats): Project {
  return {
    id: dbProject.id,
    name: dbProject.name,
    description: dbProject.description ?? '',
    icon: dbProject.icon ?? 'folder',
    color: dbProject.color,
    statuses: [], // Loaded separately
    isDefault: dbProject.isInbox,
    isArchived: !!dbProject.archivedAt,
    createdAt: new Date(dbProject.createdAt),
    taskCount: 'taskCount' in dbProject ? dbProject.taskCount : 0
  }
}

// =============================================================================
// TYPES
// =============================================================================

interface TasksContextValue {
    // Data
    tasks: Task[];
    projects: Project[];

    // Selection state
    taskSelectedId: string;
    taskSelectedType: TaskSelectionType;
    selectedTaskIds: Set<string>;

    // Actions
    setTasks: (tasks: Task[] | ((prev: Task[]) => Task[])) => void;
    setProjects: (projects: Project[] | ((prev: Project[]) => Project[])) => void;
    setSelection: (id: string, type: TaskSelectionType) => void;
    setSelectedTaskIds: (ids: Set<string>) => void;

    // Task operations
    addTask: (task: Task) => void;
    updateTask: (taskId: string, updates: Partial<Task>) => void;
    deleteTask: (taskId: string) => void;

    // Project operations
    addProject: (project: Project) => void;
    updateProject: (projectId: string, updates: Partial<Project>) => void;
    deleteProject: (projectId: string) => void;
}

interface TasksProviderProps {
    children: ReactNode;
    initialTasks: Task[];
    initialProjects: Project[];
    onTasksChange?: (tasks: Task[]) => void;
    onProjectsChange?: (projects: Project[]) => void;
}

// =============================================================================
// CONTEXT
// =============================================================================

const TasksContext = createContext<TasksContextValue | null>(null);

// =============================================================================
// HOOK
// =============================================================================

export const useTasksContext = (): TasksContextValue => {
    const context = useContext(TasksContext);
    if (!context) {
        throw new Error('useTasksContext must be used within a TasksProvider');
    }
    return context;
};

/**
 * Optional hook that returns null if used outside provider
 * Useful for components that can work with or without TasksContext
 */
export const useTasksOptional = (): TasksContextValue | null => {
    return useContext(TasksContext);
};

// =============================================================================
// PROVIDER
// =============================================================================

export const TasksProvider = ({
  children,
  initialTasks,
  initialProjects,
  onTasksChange,
  onProjectsChange
}: TasksProviderProps): React.JSX.Element => {
  // Get vault status to know if database is available
  const { status: vaultStatus } = useVault()
  const isVaultOpen = vaultStatus?.isOpen ?? false

  // Core state
  const [tasks, setTasksState] = useState<Task[]>(initialTasks)
  const [projects, setProjectsState] = useState<Project[]>(initialProjects)
  const [isLoaded, setIsLoaded] = useState(false)

  // Selection state
  const [taskSelectedId, setTaskSelectedId] = useState<string>('all')
  const [taskSelectedType, setTaskSelectedType] = useState<TaskSelectionType>('view')
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set())

  // Load data from database when vault opens
  useEffect(() => {
    if (!isVaultOpen || isLoaded) return

    const loadFromDatabase = async () => {
      try {
        // Load projects first
        const projectsResponse = await tasksService.listProjects()
        const baseProjects = projectsResponse.projects.map(dbProjectToUiProject)

        // T004: Load statuses for each project
        const projectsWithStatuses = await Promise.all(
          baseProjects.map(async (project) => {
            try {
              const statuses = await tasksService.listStatuses(project.id)
              return {
                ...project,
                statuses: statuses.map(dbStatusToUiStatus)
              }
            } catch (error) {
              console.warn(`[TasksProvider] Failed to load statuses for project ${project.id}:`, error)
              return project // Return project without statuses on error
            }
          })
        )

        setProjectsState(projectsWithStatuses)
        onProjectsChange?.(projectsWithStatuses)

        // Load tasks
        const tasksResponse = await tasksService.list({
          includeCompleted: false,
          includeArchived: false,
          limit: 1000 // Load up to 1000 tasks
        })
        const uiTasks = tasksResponse.tasks.map(dbTaskToUiTask)
        setTasksState(uiTasks)
        onTasksChange?.(uiTasks)

        setIsLoaded(true)
        console.log('[TasksProvider] Loaded from database:', {
          projects: projectsWithStatuses.length,
          tasks: uiTasks.length,
          totalStatuses: projectsWithStatuses.reduce((sum, p) => sum + p.statuses.length, 0)
        })
      } catch (error) {
        console.error('[TasksProvider] Failed to load from database:', error)
        // Keep using initial data on error
      }
    }

    loadFromDatabase()
  }, [isVaultOpen, isLoaded, onProjectsChange, onTasksChange])

  // Reset loaded state when vault closes
  useEffect(() => {
    if (!isVaultOpen) {
      setIsLoaded(false)
    }
  }, [isVaultOpen])

  // Subscribe to database events for real-time updates
  useEffect(() => {
    if (!isVaultOpen) return

    const unsubTaskCreated = onTaskCreated((event) => {
      const uiTask = dbTaskToUiTask(event.task as DbTask)
      setTasksState((prev) => {
        if (prev.some((t) => t.id === uiTask.id)) return prev
        return [uiTask, ...prev]
      })
    })

    const unsubTaskUpdated = onTaskUpdated((event) => {
      const uiTask = dbTaskToUiTask(event.task as DbTask)
      setTasksState((prev) => prev.map((t) => (t.id === event.id ? uiTask : t)))
    })

    const unsubTaskDeleted = onTaskDeleted((event) => {
      setTasksState((prev) => prev.filter((t) => t.id !== event.id))
    })

    const unsubProjectCreated = onProjectCreated((event) => {
      const uiProject = dbProjectToUiProject(event.project as DbProject)
      setProjectsState((prev) => {
        if (prev.some((p) => p.id === uiProject.id)) return prev
        return [...prev, uiProject]
      })
    })

    const unsubProjectUpdated = onProjectUpdated((event) => {
      const uiProject = dbProjectToUiProject(event.project as DbProject)
      setProjectsState((prev) => prev.map((p) => (p.id === event.id ? uiProject : p)))
    })

    const unsubProjectDeleted = onProjectDeleted((event) => {
      setProjectsState((prev) => prev.filter((p) => p.id !== event.id))
    })

    return () => {
      unsubTaskCreated()
      unsubTaskUpdated()
      unsubTaskDeleted()
      unsubProjectCreated()
      unsubProjectUpdated()
      unsubProjectDeleted()
    }
  }, [isVaultOpen])

  // Wrapped setters that also call external handlers
  const setTasks = useCallback(
    (updater: Task[] | ((prev: Task[]) => Task[])) => {
      setTasksState((prev) => {
        const newTasks = typeof updater === 'function' ? updater(prev) : updater
        onTasksChange?.(newTasks)
        return newTasks
      })
    },
    [onTasksChange]
  )

  const setProjects = useCallback(
    (updater: Project[] | ((prev: Project[]) => Project[])) => {
      setProjectsState((prev) => {
        const newProjects = typeof updater === 'function' ? updater(prev) : updater
        onProjectsChange?.(newProjects)
        return newProjects
      })
    },
    [onProjectsChange]
  )

  const setSelection = useCallback((id: string, type: TaskSelectionType) => {
    setTaskSelectedId(id)
    setTaskSelectedType(type)
  }, [])

  // Task operations - now with database integration
  const addTask = useCallback(
    async (task: Task) => {
      // If vault is open, save to database - event will update state
      if (isVaultOpen) {
        try {
          await tasksService.create({
            projectId: task.projectId,
            title: task.title,
            description: task.description || null,
            priority: priorityReverseMap[task.priority] ?? 0,
            statusId: task.statusId || null,
            parentId: task.parentId || null,
            dueDate: task.dueDate ? task.dueDate.toISOString().split('T')[0] : null,
            dueTime: task.dueTime || null,
            tags: [],
            linkedNoteIds: task.linkedNoteIds
          })
          // Event listener will add to state
        } catch (error) {
          console.error('[TasksProvider] Failed to create task:', error)
          // Fallback to local state on error
          setTasks((prev) => [...prev, task])
        }
      } else {
        // No vault open, use local state only
        setTasks((prev) => [...prev, task])
      }
    },
    [isVaultOpen, setTasks]
  )

  const updateTask = useCallback(
    async (taskId: string, updates: Partial<Task>) => {
      if (isVaultOpen) {
        try {
          await tasksService.update({
            id: taskId,
            title: updates.title,
            description: updates.description ?? undefined,
            priority:
              updates.priority !== undefined ? priorityReverseMap[updates.priority] : undefined,
            projectId: updates.projectId,
            statusId: updates.statusId ?? undefined,
            parentId: updates.parentId ?? undefined,
            dueDate: updates.dueDate ? updates.dueDate.toISOString().split('T')[0] : undefined,
            dueTime: updates.dueTime ?? undefined,
            linkedNoteIds: updates.linkedNoteIds
          })
          // Event listener will update state
        } catch (error) {
          console.error('[TasksProvider] Failed to update task:', error)
          // Fallback to local state on error
          setTasks((prev) => prev.map((task) => (task.id === taskId ? { ...task, ...updates } : task)))
        }
      } else {
        setTasks((prev) => prev.map((task) => (task.id === taskId ? { ...task, ...updates } : task)))
      }
    },
    [isVaultOpen, setTasks]
  )

  const deleteTask = useCallback(
    async (taskId: string) => {
      if (isVaultOpen) {
        try {
          await tasksService.delete(taskId)
          // Event listener will remove from state
        } catch (error) {
          console.error('[TasksProvider] Failed to delete task:', error)
          setTasks((prev) => prev.filter((t) => t.id !== taskId))
        }
      } else {
        setTasks((prev) => prev.filter((t) => t.id !== taskId))
      }
    },
    [isVaultOpen, setTasks]
  )

  // Project operations - now with database integration
  const addProject = useCallback(
    async (project: Project) => {
      if (isVaultOpen) {
        try {
          await tasksService.createProject({
            name: project.name,
            description: project.description || null,
            color: project.color,
            icon: project.icon || null
          })
          // Event listener will add to state
        } catch (error) {
          console.error('[TasksProvider] Failed to create project:', error)
          setProjects((prev) => [...prev, project])
        }
      } else {
        setProjects((prev) => [...prev, project])
      }
    },
    [isVaultOpen, setProjects]
  )

  const updateProject = useCallback(
    async (projectId: string, updates: Partial<Project>) => {
      if (isVaultOpen) {
        try {
          await tasksService.updateProject({
            id: projectId,
            name: updates.name,
            description: updates.description ?? undefined,
            color: updates.color,
            icon: updates.icon ?? undefined
          })
          // Event listener will update state
        } catch (error) {
          console.error('[TasksProvider] Failed to update project:', error)
          setProjects((prev) =>
            prev.map((project) => (project.id === projectId ? { ...project, ...updates } : project))
          )
        }
      } else {
        setProjects((prev) =>
          prev.map((project) => (project.id === projectId ? { ...project, ...updates } : project))
        )
      }
    },
    [isVaultOpen, setProjects]
  )

  const deleteProject = useCallback(
    async (projectId: string) => {
      if (isVaultOpen) {
        try {
          await tasksService.deleteProject(projectId)
          // Event listener will remove from state
        } catch (error) {
          console.error('[TasksProvider] Failed to delete project:', error)
          setProjects((prev) => prev.filter((p) => p.id !== projectId))
        }
      } else {
        setProjects((prev) => prev.filter((p) => p.id !== projectId))
      }
    },
    [isVaultOpen, setProjects]
  )

  // Memoized context value
  const value = useMemo<TasksContextValue>(
    () => ({
      tasks,
      projects,
      taskSelectedId,
      taskSelectedType,
      selectedTaskIds,
      setTasks,
      setProjects,
      setSelection,
      setSelectedTaskIds,
      addTask,
      updateTask,
      deleteTask,
      addProject,
      updateProject,
      deleteProject
    }),
    [
      tasks,
      projects,
      taskSelectedId,
      taskSelectedType,
      selectedTaskIds,
      setTasks,
      setProjects,
      setSelection,
      addTask,
      updateTask,
      deleteTask,
      addProject,
      updateProject,
      deleteProject
    ]
  )

  return <TasksContext.Provider value={value}>{children}</TasksContext.Provider>
}

export default TasksProvider;
