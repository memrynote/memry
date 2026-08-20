import { useCallback, useMemo } from 'react'
import { useTasksContext } from '@/contexts/tasks'
import { useTabActions } from '@/contexts/tabs'
import { useUndoableTaskActions } from '@/hooks/use-undoable-task-actions'
import { useUndoTracker } from '@/hooks'
import { openRelatedVaultItem } from '@/lib/open-related-vault-item'
import { openLinkedEvent } from '@/pages/project/open-linked-item'
import { notesService } from '@/services/notes-service'
import { tasksService } from '@/services/tasks-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import type { ProjectLinkedEvent } from '@memry/rpc/tasks'
import type { ProjectHubData, ProjectTabKey } from '@/pages/project/use-project-hub'
import type { HubHandlers } from '@/pages/project/tabs/hub-handlers'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'

const log = createLogger('ProjectWidget')

interface Options {
  hub: ProjectHubData
  /** Switches the widget's own tab strip; the widget holds this in React state. */
  onGoToTab: (tab: ProjectTabKey) => void
  /** Opens the full project page on a given tab — the escape hatch for the two
   *  add-actions that need page chrome the widget does not have. */
  onOpenProjectPage: (tab: ProjectTabKey) => void
}

/**
 * The widget's copy of the project hub's interactions.
 *
 * Deliberately NOT shared with `pages/project/index.tsx`: that page threads its
 * handlers through a capture input, an import drop zone and a details rail, none
 * of which exist here. Extracting a common hook would mean reshaping the page's
 * wiring to accommodate a surface it knows nothing about; the overlap is a dozen
 * one-line callbacks, so this file carries them instead.
 *
 * Two handlers differ from the page on purpose. `onAddTask` and `onAddFile` need
 * the page's capture bar and file drop zone, so in the widget they open the
 * project page on the right tab rather than silently doing nothing.
 */
export function useProjectWidgetHandlers({
  hub,
  onGoToTab,
  onOpenProjectPage
}: Options): HubHandlers {
  const { t } = useT('tasks')
  const { tasks, projects, addTask, updateTask, deleteTask } = useTasksContext()
  const { registerUndo, removeUndoEntry } = useUndoTracker()
  const { openTab } = useTabActions()
  const project = hub.project

  const undoable = useUndoableTaskActions({
    tasks,
    projects,
    addTask: (...args) => void addTask(...args),
    updateTask: (...args) => void updateTask(...args),
    deleteTask: (...args) => void deleteTask(...args),
    registerUndo,
    removeUndoEntry
  })

  const handleOpenNote = useCallback(
    (noteId: string) => void openRelatedVaultItem(noteId, openTab),
    [openTab]
  )

  const handleOpenEvent = useCallback(
    (event: ProjectLinkedEvent) => openLinkedEvent(event, openTab, Date.now()),
    [openTab]
  )

  const handleNoteIconChange = useCallback(
    (noteId: string, icon: string | null) => {
      void notesService
        .update({ id: noteId, emoji: icon })
        .then(() => hub.refresh())
        .catch((error) => log.error('Failed to set note icon', extractErrorMessage(error)))
    },
    [hub]
  )

  const handleToggleComplete = useCallback(
    (taskId: string) => {
      const task = tasks.find((candidate) => candidate.id === taskId)
      if (!task || !project) return
      const status = project.statuses.find((candidate) => candidate.id === task.statusId)
      if (!status) return
      if (status.type === 'done') undoable.uncompleteTask(taskId)
      else undoable.completeTask(taskId)
    },
    [tasks, project, undoable]
  )

  // Same destination as the project page: the Tasks page with the detail drawer
  // already focused on that task. The widget has no task editor of its own.
  const handleOpenTask = useCallback(
    (taskId: string) => {
      openTab({
        type: 'tasks',
        title: 'Tasks',
        icon: 'CheckSquare',
        path: '/tasks',
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false,
        viewState: {
          openTaskId: taskId,
          selectedProjectId: project?.id ?? null,
          activeInternalTab: 'all',
          activeTab: 'all'
        }
      })
    },
    [openTab, project]
  )

  const handleAddNote = useCallback(async (): Promise<void> => {
    if (!project) return
    try {
      const created = await notesService.create({
        title: t('projectHub.sections.newNoteTitle', { name: project.name })
      })
      if (!created.success || !created.note) throw new Error(created.error ?? 'no note returned')

      const linked = await tasksService.linkProjectItem({
        projectId: project.id,
        itemType: 'note',
        itemId: created.note.id
      })
      if (!linked.success) throw new Error(linked.error)

      hub.refresh()
      handleOpenNote(created.note.id)
    } catch (error) {
      log.error('Failed to add note to project', extractErrorMessage(error))
      toast.error(extractErrorMessage(error, t('projectHub.sections.newNoteError')))
    }
  }, [project, hub, handleOpenNote, t])

  const handleAddEvent = useCallback(() => {
    openTab({
      type: 'calendar',
      title: 'Calendar',
      icon: 'calendar',
      path: '/calendar',
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false,
      viewState: { createEventAt: Date.now() }
    })
  }, [openTab])

  return useMemo(
    () => ({
      onGoToTab,
      onOpenTask: handleOpenTask,
      onStatusChange: (taskId, statusId) => void updateTask(taskId, { statusId }),
      onToggleComplete: handleToggleComplete,
      onPriorityChange: (taskId, priority) => void updateTask(taskId, { priority }),
      onOpenNote: handleOpenNote,
      onNoteIconChange: handleNoteIconChange,
      onOpenFile: handleOpenNote,
      onOpenEvent: handleOpenEvent,
      onAddTask: () => onOpenProjectPage('tasks'),
      onAddNote: () => void handleAddNote(),
      onAddFile: () => onOpenProjectPage('files'),
      onAddEvent: handleAddEvent
    }),
    [
      onGoToTab,
      onOpenProjectPage,
      updateTask,
      handleOpenTask,
      handleToggleComplete,
      handleOpenNote,
      handleNoteIconChange,
      handleOpenEvent,
      handleAddNote,
      handleAddEvent
    ]
  )
}
