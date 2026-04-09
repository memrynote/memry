import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { Task } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'
import type { TaskSelectionType } from '@/App'

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
  deleteProject,
  getOrderedTasks
}: TasksProviderProps): React.JSX.Element => {
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
      deleteProject,
      getOrderedTasks
    }),
    [
      tasks,
      projects,
      taskSelectedId,
      taskSelectedType,
      selectedTaskIds,
      setSelection,
      setSelectedTaskIds,
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
