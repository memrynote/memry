import { useCallback, useMemo, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { useTasksContext } from '@/contexts/tasks'
import { useTabActions } from '@/contexts/tabs'
import type { Task } from '@/data/task-model'
import { createSubtask, describeBranch } from '@/lib/subtask-utils'
import { useTaskPreferences } from '@/hooks/use-task-preferences'
import { useUndoTracker } from '@/hooks/use-undo'
import { useUndoableTaskActions } from '@/hooks/use-undoable-task-actions'
import { openRelatedVaultItem } from '@/lib/open-related-vault-item'
import { canvasTabData } from '@/lib/sidebar-tab-data'
import { DeleteParentDialog } from './dialogs/delete-parent-dialog'
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
  const {
    settings: { nestedSubtasks }
  } = useTaskPreferences()
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
      const result = createSubtask({ parentId, title, allowNested: nestedSubtasks }, tasks)
      if (result.success && result.newTask) void addTask(result.newTask)
    },
    [tasks, addTask, nestedSubtasks]
  )

  const { registerUndo, removeUndoEntry } = useUndoTracker()
  const undoable = useUndoableTaskActions({
    tasks,
    projects,
    addTask,
    updateTask: (...args) => void updateTask(...args),
    deleteTask: (...args) => void deleteTask(...args),
    registerUndo,
    removeUndoEntry
  })

  // A task with subtasks asks what happens to them, like the Tasks page does.
  const [pendingDeleteParentId, setPendingDeleteParentId] = useState<string | null>(null)
  const pendingDeleteParent = useMemo(
    () => tasks.find((t) => t.id === pendingDeleteParentId) ?? null,
    [tasks, pendingDeleteParentId]
  )
  const pendingDeleteBranch = useMemo(
    () => describeBranch(pendingDeleteParentId, tasks),
    [pendingDeleteParentId, tasks]
  )

  const handleDeleteTask = useCallback(
    (id: string) => {
      undoable.deleteTask(id)
      onClose()
    },
    [undoable, onClose]
  )

  const handleConfirmDeleteParent = useCallback(
    (keepSubtasks: boolean) => {
      if (!pendingDeleteParentId) return
      undoable.deleteTask(pendingDeleteParentId, keepSubtasks ? 'keep' : 'delete')
      setPendingDeleteParentId(null)
      onClose()
    },
    [pendingDeleteParentId, undoable, onClose]
  )

  const handleNoteClick = useCallback(
    (noteId: string) => void openRelatedVaultItem(noteId, openTab),
    [openTab]
  )

  const handleCanvasClick = useCallback(
    (canvasId: string, title: string | null) => {
      openTab(canvasTabData({ id: canvasId, title }, tCommon('canvas.untitled')))
    },
    [openTab, tCommon]
  )

  const handleOpenInTasks = useCallback(() => {
    openTaskInTasksTab(openTab, taskId, task?.projectId)
    onClose()
  }, [openTab, taskId, task?.projectId, onClose])

  return (
    <>
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
        onDeleteParentTask={setPendingDeleteParentId}
        onOpenInTasks={handleOpenInTasks}
        allowNestedSubtasks={nestedSubtasks}
        // Above the note's outline rail (z-40), which sits at the same edge. A
        // host tab has no toolbar of its own to clear, so the drawer starts at the top.
        className="top-0 z-40"
      />
      <DeleteParentDialog
        open={pendingDeleteParent !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteParentId(null)
        }}
        parent={pendingDeleteParent}
        branch={pendingDeleteBranch}
        onConfirm={handleConfirmDeleteParent}
      />
    </>
  )
}
