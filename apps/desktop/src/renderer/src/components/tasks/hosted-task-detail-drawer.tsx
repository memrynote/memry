import { useCallback, useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'
import { useTasksContext } from '@/contexts/tasks'
import { useTabActions } from '@/contexts/tabs'
import type { Task } from '@/data/task-model'
import { createSubtask } from '@/lib/subtask-utils'
import { openRelatedVaultItem } from '@/lib/open-related-vault-item'
import { canvasTabData } from '@/lib/sidebar-tab-data'
import { TaskDetailDrawer } from './task-detail-drawer'
import { openTaskInTasksTab } from './task-detail-host'

interface HostedTaskDetailDrawerProps {
  taskId: string
  onClose: () => void
}

/** The Tasks page drawer, wired to the workspace task data instead of that page's state. */
export const HostedTaskDetailDrawer = ({
  taskId,
  onClose
}: HostedTaskDetailDrawerProps): React.JSX.Element => {
  const { t: tCommon } = useT('common')
  const { tasks, projects, addTask, updateTask, deleteTask } = useTasksContext()
  const { openTab } = useTabActions()
  const task = useMemo(() => tasks.find((t) => t.id === taskId) ?? null, [tasks, taskId])

  const handleToggleComplete = useCallback(
    (id: string) => {
      const target = tasks.find((t) => t.id === id)
      if (target) void updateTask(id, { completedAt: target.completedAt ? null : new Date() })
    },
    [tasks, updateTask]
  )

  const handleUpdateTask = useCallback(
    (id: string, updates: Partial<Task>) => void updateTask(id, updates),
    [updateTask]
  )

  const handleAddSubtask = useCallback(
    (parentId: string, title: string) => {
      const result = createSubtask({ parentId, title }, tasks)
      if (result.success && result.newTask) void addTask(result.newTask)
    },
    [tasks, addTask]
  )

  const handleDeleteTask = useCallback(
    (id: string) => {
      void deleteTask(id)
      onClose()
    },
    [deleteTask, onClose]
  )

  const handleNoteClick = useCallback(
    (noteId: string) => void openRelatedVaultItem(noteId, openTab),
    [openTab]
  )

  const handleCanvasClick = useCallback(
    (canvasId: string, title: string | null) =>
      openTab(canvasTabData({ id: canvasId, title }, tCommon('canvas.untitled'))),
    [openTab, tCommon]
  )

  const handleOpenInTasks = useCallback(() => {
    openTaskInTasksTab(openTab, taskId, task?.projectId)
    onClose()
  }, [openTab, taskId, task?.projectId, onClose])

  return (
    <TaskDetailDrawer
      key={taskId}
      task={task}
      isOpen={task !== null}
      onClose={onClose}
      tasks={tasks}
      projects={projects}
      onToggleComplete={handleToggleComplete}
      onUpdateTask={handleUpdateTask}
      onAddSubtask={handleAddSubtask}
      onNoteClick={handleNoteClick}
      onCanvasClick={handleCanvasClick}
      onDeleteTask={handleDeleteTask}
      onOpenInTasks={handleOpenInTasks}
      // Above the note's outline rail (z-40), which sits at the same edge.
      className="z-40"
    />
  )
}
