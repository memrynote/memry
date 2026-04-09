import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { Task } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'
import type { TaskSelectionType } from '@/App'
import { useTaskWorkspaceMutations, useTaskWorkspaceData } from '@/features/tasks/use-task-queries'
import { useTaskUiStore } from '@/features/tasks/use-task-ui-store'

interface TasksContextValue {
  tasks: Task[]
  projects: Project[]
  taskSelectedId: string
  taskSelectedType: TaskSelectionType
  selectedTaskIds: Set<string>
  setTasks: (tasks: Task[] | ((prev: Task[]) => Task[])) => void
  setProjects: (projects: Project[] | ((prev: Project[]) => Project[])) => void
  setSelection: (id: string, type: TaskSelectionType) => void
  setSelectedTaskIds: (ids: Set<string>) => void
  addTask: (task: Task) => Promise<void>
  updateTask: (taskId: string, updates: Partial<Task>) => Promise<void>
  deleteTask: (taskId: string) => Promise<void>
  addProject: (project: Project) => Promise<void>
  updateProject: (projectId: string, updates: Partial<Project>) => Promise<void>
  deleteProject: (projectId: string) => Promise<void>
  getOrderedTasks?: (sectionId: string, tasks: Task[]) => Task[]
}

interface TasksProviderProps {
  children: ReactNode
  tasks?: Task[]
  projects?: Project[]
  initialTasks?: Task[]
  initialProjects?: Project[]
  getOrderedTasks?: (sectionId: string, tasks: Task[]) => Task[]
}

const TasksContext = createContext<TasksContextValue | null>(null)

export const useTasksContext = (): TasksContextValue => {
  const context = useContext(TasksContext)
  if (!context) {
    throw new Error('useTasksContext must be used within a TasksProvider')
  }
  return context
}

export const useTasksOptional = (): TasksContextValue | null => {
  return useContext(TasksContext)
}

export const TasksProvider = ({
  children,
  tasks,
  projects,
  initialTasks,
  initialProjects,
  getOrderedTasks
}: TasksProviderProps): React.JSX.Element => {
  const shouldLoadWorkspace =
    tasks === undefined &&
    projects === undefined &&
    initialTasks === undefined &&
    initialProjects === undefined

  const workspace = useTaskWorkspaceData({ enabled: shouldLoadWorkspace })
  const uiStore = useTaskUiStore()
  const {
    setTasks,
    setProjects,
    addTask,
    updateTask,
    deleteTask,
    addProject,
    updateProject,
    deleteProject
  } = useTaskWorkspaceMutations()

  const resolvedTasks = tasks ?? initialTasks ?? workspace.tasks
  const resolvedProjects = projects ?? initialProjects ?? workspace.projects

  const value = useMemo<TasksContextValue>(
    () => ({
      tasks: resolvedTasks,
      projects: resolvedProjects,
      taskSelectedId: uiStore.taskSelectedId,
      taskSelectedType: uiStore.taskSelectedType,
      selectedTaskIds: uiStore.selectedTaskIds,
      setTasks,
      setProjects,
      setSelection: uiStore.setSelection,
      setSelectedTaskIds: uiStore.setSelectedTaskIds,
      addTask,
      updateTask,
      deleteTask,
      addProject,
      updateProject,
      deleteProject,
      getOrderedTasks
    }),
    [
      resolvedTasks,
      resolvedProjects,
      uiStore.taskSelectedId,
      uiStore.taskSelectedType,
      uiStore.selectedTaskIds,
      uiStore.setSelection,
      uiStore.setSelectedTaskIds,
      setTasks,
      setProjects,
      addTask,
      updateTask,
      deleteTask,
      addProject,
      updateProject,
      deleteProject,
      getOrderedTasks
    ]
  )

  return <TasksContext.Provider value={value}>{children}</TasksContext.Provider>
}

export default TasksProvider
