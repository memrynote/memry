import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { FolderKanban } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { TaskList } from '@/components/tasks/task-list'
import { ProjectModal } from '@/components/tasks/project-modal'
import { useTasksContext } from '@/contexts/tasks'
import { useTabActions, useActiveTab } from '@/contexts/tabs'
import { useUndoableTaskActions } from '@/hooks/use-undoable-task-actions'
import { useUndoTracker } from '@/hooks'
import { getDefaultTodoStatus } from '@/lib/task-utils'
import { createDefaultTask, type Priority, type RepeatConfig } from '@/data/task-model'
import { openRelatedVaultItem } from '@/lib/open-related-vault-item'
import { notesService } from '@/services/notes-service'
import { tasksService } from '@/services/tasks-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { trackTelemetry } from '@/lib/telemetry'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import type { Project } from '@/data/tasks-data'
import type { ProjectLinkedEvent } from '@memry/rpc/tasks'
import { useProjectHub, type ProjectTabKey } from './use-project-hub'
import { PROJECT_RAIL_VISIBLE, readProjectTab, readRailOpen } from './project-view-state'
import { ProjectTabBar } from './project-tab-bar'
import { ProjectRail } from './project-rail'
import { ProjectCaptureInput } from './project-capture-input'
import { OverviewTab } from './tabs/overview-tab'
import { ListTab } from './tabs/list-tab'
import type { HubHandlers } from './tabs/hub-handlers'
import { openLinkedEvent } from './open-linked-item'

const log = createLogger('ProjectHub')

interface ProjectPageProps {
  projectId?: string
  className?: string
}

export const ProjectPage = ({ projectId, className }: ProjectPageProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const { tasks, projects, addTask, updateTask, deleteTask, updateProject } = useTasksContext()
  const { registerUndo, removeUndoEntry } = useUndoTracker()
  const { openTab, saveTabState } = useTabActions()
  const activeTab = useActiveTab()

  const hub = useProjectHub(projectId)

  // page_viewed dedupes by tab TYPE, so switching between two project tabs is
  // invisible there; this counts each distinct project-hub open instead.
  useEffect(() => {
    if (!projectId) return
    void trackTelemetry('project_opened', { surface: 'projects', action: 'opened' })
  }, [projectId])
  const project = hub.project

  const [isEditing, setIsEditing] = useState(false)
  // Scroll-edge state for the page chrome, mirroring Inbox and Tasks. The tabs
  // own their scrollers, so this listens in the capture phase from the root.
  const [isScrolled, setIsScrolled] = useState(false)
  // Bumped to move focus into the capture input (the Tasks section's "+").
  const [captureFocusSignal, setCaptureFocusSignal] = useState(0)
  const [importSignal, setImportSignal] = useState(0)

  const undoable = useUndoableTaskActions({
    tasks,
    projects,
    addTask: (...args) => void addTask(...args),
    updateTask: (...args) => void updateTask(...args),
    deleteTask: (...args) => void deleteTask(...args),
    registerUndo,
    removeUndoEntry
  })

  const handleScrollCapture = useCallback((event: React.UIEvent<HTMLElement>) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    setIsScrolled(target.scrollTop > 0)
  }, [])

  const activeTabKey = readProjectTab(activeTab?.viewState)
  const railOpen = readRailOpen(activeTab?.viewState)

  const writeViewState = useCallback(
    (patch: Record<string, unknown>) => {
      if (!activeTab) return
      saveTabState(activeTab.id, { viewState: { ...activeTab.viewState, ...patch } })
    },
    [activeTab, saveTabState]
  )

  const goToTab = useCallback(
    (tab: ProjectTabKey) => writeViewState({ projectTab: tab }),
    [writeViewState]
  )

  const toggleRail = useCallback(
    () => writeViewState({ railOpen: !railOpen }),
    [writeViewState, railOpen]
  )

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

  const handleQuickAdd = useCallback(
    (
      title: string,
      // Widened rather than `CaptureBarParsed`: the task list's empty state
      // calls this with a title only.
      parsedData?: {
        dueDate: Date | null
        dueTime?: string | null
        priority: Priority
        projectId: string | null
        repeat?: RepeatConfig | null
      }
    ) => {
      if (!project) return
      const statusId = getDefaultTodoStatus(project)?.id || project.statuses[0]?.id
      if (!statusId) return
      const newTask = createDefaultTask(project.id, statusId, title, parsedData?.dueDate ?? null)
      if (parsedData?.priority) newTask.priority = parsedData.priority
      newTask.dueTime = parsedData?.dueTime ?? null
      if (parsedData?.repeat) {
        newTask.isRepeating = true
        newTask.repeatConfig = parsedData.repeat
      }
      undoable.createTask(newTask)
    },
    [project, undoable]
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

  // Archiving goes through the dedicated PROJECT_ARCHIVE IPC — the generic
  // updateProject path has no archived field in ProjectUpdateSchema, so routing
  // { isArchived: true } through it silently no-ops.
  const handleArchiveProject = useCallback(async (): Promise<void> => {
    if (!project) return
    try {
      const result = await tasksService.archiveProject(project.id)
      if (!result.success) throw new Error(result.error ?? 'Failed to archive project')
      void trackTelemetry('project_archived', {
        surface: 'tasks',
        action: 'archived',
        objectType: 'project',
        result: 'success'
      })
      toast.success(t('toasts.projectArchived'))
    } catch (error) {
      log.error('Failed to archive project', extractErrorMessage(error))
      trackRendererError('project_archive', error)
      toast.error(t('toasts.projectArchiveError'))
    }
  }, [project, t])

  // Tasks open where every other surface opens them: the Tasks tab with the
  // detail drawer already focused on that task (see calendar-task-popover and
  // tag-detail-view). The hub itself has no task editor to route to.
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
          selectedProjectId: projectId ?? null,
          activeInternalTab: 'all',
          activeTab: 'all'
        }
      })
    },
    [openTab, projectId]
  )

  // Creating an event lives in the Calendar, which owns the whole event editor.
  // The hub opens it on today with the create intent the Calendar already reads.
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

  const handlers: HubHandlers = useMemo(
    () => ({
      onGoToTab: goToTab,
      onOpenTask: handleOpenTask,
      onStatusChange: (taskId, statusId) => void updateTask(taskId, { statusId }),
      onToggleComplete: handleToggleComplete,
      onPriorityChange: (taskId, priority) => void updateTask(taskId, { priority }),
      onOpenNote: handleOpenNote,
      onNoteIconChange: handleNoteIconChange,
      onOpenFile: handleOpenNote,
      onOpenEvent: handleOpenEvent,
      onAddTask: () => setCaptureFocusSignal((signal) => signal + 1),
      onAddNote: () => void handleAddNote(),
      onAddFile: () => setImportSignal((signal) => signal + 1),
      onAddEvent: handleAddEvent
    }),
    [
      goToTab,
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

  if (!projectId || !project) {
    return (
      <div
        className={cn(
          'flex h-full flex-col items-center justify-center p-8 text-center',
          className
        )}
      >
        <FolderKanban className="mb-4 size-12 text-muted-foreground/50" aria-hidden="true" />
        <p className="mb-2 text-lg font-medium text-foreground">{t('projectHome.emptyTitle')}</p>
        <p className="text-sm text-muted-foreground">{t('projectHome.emptyBody')}</p>
      </div>
    )
  }

  return (
    <div
      className={cn('flex h-full min-h-0 flex-col', className)}
      onScrollCapture={handleScrollCapture}
    >
      {/*
        The page chrome, the same band Inbox and Tasks put above their content:
        translucent blur plus the scroll-edge shadow. The hub's header is two
        rows (capture, then tabs), so the band wraps both and the shadow lands
        under the block rather than between its rows.
      */}
      <div data-scrolled={isScrolled || undefined} className="page-chrome z-30 shrink-0">
        <ProjectCaptureInput
          project={project}
          projects={projects}
          onAddTask={handleQuickAdd}
          onChanged={hub.refresh}
          focusSignal={captureFocusSignal}
          importSignal={importSignal}
        />

        <ProjectTabBar
          active={activeTabKey}
          onChange={goToTab}
          counts={hub.counts}
          railOpen={railOpen}
          onToggleRail={toggleRail}
          onEdit={() => setIsEditing(true)}
          onArchive={() => void handleArchiveProject()}
        />
      </div>

      <div className="flex min-h-0 flex-1">
        {/*
          A flex column, NOT a scroll container: VirtualizedProjectTaskList sizes
          itself with `flex-1` and sets `contain: strict` on its scroller, so it
          takes no height from its content. Inside a plain block wrapper it
          collapses to zero and renders no rows at all. Tasks therefore scrolls
          itself; the other tabs get their own scroll wrapper below.
        */}
        <div className="flex min-w-0 flex-1 flex-col">
          {activeTabKey === 'overview' ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <OverviewTab project={project} hub={hub} handlers={handlers} />
            </div>
          ) : activeTabKey === 'tasks' ? (
            <TaskList
              tasks={hub.tasks}
              projects={projects}
              selectedId={project.id}
              selectedType="project"
              // The hub's own gutter, so tasks sit in the same column as the
              // overview's rows instead of running edge to edge.
              contentClassName="px-4 pb-6"
              onToggleComplete={handleToggleComplete}
              onUpdateTask={(taskId, updates) => void updateTask(taskId, updates)}
              onQuickAdd={handleQuickAdd}
              onTaskClick={handleOpenTask}
              onNoteClick={handleOpenNote}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ListTab kind={activeTabKey} hub={hub} handlers={handlers} />
            </div>
          )}
        </div>

        {PROJECT_RAIL_VISIBLE && railOpen ? (
          <ProjectRail
            projectId={project.id}
            homeNoteId={hub.homeNoteId}
            onHomeNoteChange={(noteId) => {
              hub.setHomeNoteId(noteId)
              hub.refresh()
            }}
            pinnedNotes={hub.pinnedNotes}
            progress={hub.progress}
            createdAt={hub.createdAt}
            modifiedAt={hub.modifiedAt}
            counts={hub.counts}
            onOpenNote={handleOpenNote}
            onNoteIconChange={handleNoteIconChange}
            onChanged={hub.refresh}
          />
        ) : null}
      </div>

      <ProjectModal
        isOpen={isEditing}
        onClose={() => setIsEditing(false)}
        onSave={(updated: Project) => {
          // updateProject rejects on failure (already logged + tracked there);
          // this surface has no failure toast, so just avoid an unhandled rejection.
          updateProject(updated.id, updated).catch(() => {})
          setIsEditing(false)
        }}
        project={project}
      />
    </div>
  )
}

export default ProjectPage
