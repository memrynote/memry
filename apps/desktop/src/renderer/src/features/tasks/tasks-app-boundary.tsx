import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { DragEndEvent } from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { DragProvider, type DragState } from '@/contexts/drag-context'
import { DroppedPriorityProvider } from '@/contexts/dropped-priority-context'
import { TasksProvider } from '@/contexts/tasks'
import { taskViews, type Project } from '@/data/tasks-data'
import { useDragHandlers, useTaskOrder } from '@/hooks'
import { tasksService } from '@/services/tasks-service'
import {
  useTaskWorkspaceData,
  useTaskWorkspaceMutations
} from '@/features/tasks/use-task-queries'
import { useTaskUiStore } from '@/features/tasks/use-task-ui-store'
import { getFilteredTasks } from '@/lib/task-utils'

interface TasksAppRenderProps {
  projects: Project[]
  viewCounts: Record<string, number>
}

interface TasksAppBoundaryProps {
  children: (props: TasksAppRenderProps) => ReactNode
}

export function TasksAppBoundary({ children }: TasksAppBoundaryProps): React.JSX.Element {
  const { tasks, projects } = useTaskWorkspaceData({ enabled: true })
  const {
    setTasks,
    setProjects,
    addTask,
    addProject,
    updateTask: handleUpdateTask,
    updateProject,
    deleteTask: handleDeleteTask,
    deleteProject
  } = useTaskWorkspaceMutations()
  const {
    taskSelectedId,
    taskSelectedType,
    selectedTaskIds,
    setSelection,
    setSelectedTaskIds
  } = useTaskUiStore()
  const selectedTaskIdsRef = useRef(selectedTaskIds)

  useEffect(() => {
    selectedTaskIdsRef.current = selectedTaskIds
  }, [selectedTaskIds])

  const viewCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    taskViews.forEach((view) => {
      const filtered = getFilteredTasks(tasks, view.id, 'view', projects)
      counts[view.id] = filtered.length
    })
    return counts
  }, [tasks, projects])

  const projectsWithCounts = useMemo(() => {
    return projects.map((project) => {
      const projectTasks = tasks.filter((task) => task.projectId === project.id)
      const incompleteTasks = projectTasks.filter((task) => {
        const status = project.statuses.find((entry) => entry.id === task.statusId)
        return status?.type !== 'done'
      })
      return { ...project, taskCount: incompleteTasks.length }
    })
  }, [projects, tasks])

  const taskOrder = useTaskOrder({ persist: true })

  const handleReorder = useCallback(
    (updates: Record<string, string[] | null>) => {
      taskOrder.applyOrderUpdates(updates)
      for (const taskIds of Object.values(updates)) {
        if (!taskIds) continue
        void tasksService.reorder(
          taskIds,
          taskIds.map((_, index) => index)
        )
      }
    },
    [taskOrder]
  )

  const { handleDragEnd: taskDragEnd, droppedPriorities } = useDragHandlers({
    tasks,
    projects: projectsWithCounts,
    onUpdateTask: handleUpdateTask,
    onDeleteTask: handleDeleteTask,
    onReorder: handleReorder,
    getOrder: taskOrder.getOrder
  })

  const handleDragEnd = useCallback(
    (event: DragEndEvent, dragState: DragState) => {
      const { active, over } = event
      if (!over) return

      const activeData = active.data.current

      if (activeData?.type === undefined && over.id !== active.id) {
        const activeIndex = projects.findIndex((project) => project.id === active.id)
        const overIndex = projects.findIndex((project) => project.id === over.id)
        if (activeIndex !== -1 && overIndex !== -1) {
          setProjects((previous) => {
            const reorderedProjects = arrayMove(previous, activeIndex, overIndex)
            void tasksService.reorderProjects(
              reorderedProjects.map((project) => project.id),
              reorderedProjects.map((_, index) => index)
            )
            return reorderedProjects
          })
          return
        }
      }

      taskDragEnd(event, dragState)

      if (dragState.isDragging) {
        setSelectedTaskIds(new Set<string>())
      }
    },
    [projects, setProjects, setSelectedTaskIds, taskDragEnd]
  )

  return (
    <DragProvider
      tasks={tasks}
      selectedIds={selectedTaskIds}
      selectedIdsRef={selectedTaskIdsRef}
      onDragEnd={(event, state) => void handleDragEnd(event, state)}
    >
      <DroppedPriorityProvider value={droppedPriorities}>
        <TasksProvider
          tasks={tasks}
          projects={projectsWithCounts}
          taskSelectedId={taskSelectedId}
          taskSelectedType={taskSelectedType}
          selectedTaskIds={selectedTaskIds}
          setTasks={setTasks}
          setProjects={setProjects}
          setSelection={setSelection}
          setSelectedTaskIds={setSelectedTaskIds}
          addTask={addTask}
          updateTask={handleUpdateTask}
          deleteTask={handleDeleteTask}
          addProject={addProject}
          updateProject={updateProject}
          deleteProject={deleteProject}
          getOrderedTasks={taskOrder.getOrderedTasks}
        >
          {children({
            projects: projectsWithCounts,
            viewCounts
          })}
        </TasksProvider>
      </DroppedPriorityProvider>
    </DragProvider>
  )
}
