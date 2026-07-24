import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { FolderKanban } from '@/lib/icons'
import { getIconByName } from '@/components/icon-picker'
import { TaskList } from '@/components/tasks/task-list'
import { ProjectNotesSection } from '@/components/tasks/projects/project-notes-section'
import { ProjectFilesSection } from '@/components/tasks/projects/project-files-section'
import { ProjectEventsSection } from '@/components/tasks/projects/project-events-section'
import { ProjectOverviewNote } from '@/components/tasks/projects/project-overview-note'
import { ProjectStatsRow } from '@/components/tasks/projects/project-stats-row'
import { useTasksContext } from '@/contexts/tasks'
import { useTabActions } from '@/contexts/tabs'
import { getFilteredTasks, getDefaultTodoStatus } from '@/lib/task-utils'
import { createDefaultTask, type Priority } from '@/data/task-model'
import { useUndoableTaskActions } from '@/hooks/use-undoable-task-actions'
import { useUndoTracker } from '@/hooks'
import { tasksService, onProjectUpdated, type ProjectLink } from '@/services/tasks-service'
import { openRelatedVaultItem } from '@/lib/open-related-vault-item'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'

const log = createLogger('ProjectHome')

interface ProjectHomePageProps {
  projectId?: string
  className?: string
}

export const ProjectHomePage = ({
  projectId,
  className
}: ProjectHomePageProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const { tasks, projects, addTask, updateTask, deleteTask } = useTasksContext()
  const { registerUndo, removeUndoEntry } = useUndoTracker()
  const { openTab } = useTabActions()

  const undoable = useUndoableTaskActions({
    tasks,
    projects,
    addTask: (...args) => void addTask(...args),
    updateTask: (...args) => void updateTask(...args),
    deleteTask: (...args) => void deleteTask(...args),
    registerUndo,
    removeUndoEntry
  })

  const project = useMemo(
    () => projects.find((p) => p.id === projectId) ?? null,
    [projects, projectId]
  )

  const projectTasks = useMemo(() => {
    if (!projectId) return []
    return getFilteredTasks(tasks, projectId, 'project', projects)
  }, [tasks, projectId, projects])

  const progressPct = useMemo(() => {
    if (projectTasks.length === 0) return 0
    const done = projectTasks.filter((task) => task.completedAt != null).length
    return Math.round((done / projectTasks.length) * 100)
  }, [projectTasks])

  const [links, setLinks] = useState<ProjectLink[]>([])

  const loadLinks = useCallback(async (): Promise<void> => {
    if (!projectId) {
      setLinks([])
      return
    }
    try {
      const result = await tasksService.listProjectLinks(projectId)
      setLinks(result)
    } catch (error) {
      log.error(
        'Failed to load project links',
        extractErrorMessage(error, t('projectHome.loadError'))
      )
    }
  }, [projectId, t])

  useEffect(() => {
    void loadLinks()
  }, [loadLinks])

  // undefined = not yet resolved (avoids a "create overview note" flash
  // before the first getProject call returns); null = resolved, no home note.
  const [homeNoteId, setHomeNoteId] = useState<string | null | undefined>(undefined)

  // Tracks which projectId the most recent getProject call was for, so an
  // out-of-order response (e.g. switching projects while a call is in
  // flight) can't stomp fresher state. Mirrors the `cancelled` flag in
  // ProjectOverviewNote's note-fetch effect, adapted for a callback shared
  // by both the mount effect and the onProjectUpdated listener below.
  const latestHomeNoteRequestRef = useRef<string | undefined>(undefined)

  const loadHomeNoteId = useCallback(async (): Promise<void> => {
    if (!projectId) {
      latestHomeNoteRequestRef.current = undefined
      setHomeNoteId(null)
      return
    }
    latestHomeNoteRequestRef.current = projectId
    try {
      const result = await tasksService.getProject(projectId)
      if (latestHomeNoteRequestRef.current !== projectId) return
      setHomeNoteId(result?.homeNoteId ?? null)
    } catch (error) {
      if (latestHomeNoteRequestRef.current !== projectId) return
      log.error(
        'Failed to load project home note',
        extractErrorMessage(error, t('projectHome.overview.loadError'))
      )
    }
  }, [projectId, t])

  useEffect(() => {
    void loadHomeNoteId()
  }, [loadHomeNoteId])

  useEffect(() => {
    return onProjectUpdated((event) => {
      if (event.id === projectId) {
        void loadLinks()
        void loadHomeNoteId()
      }
    })
  }, [projectId, loadLinks, loadHomeNoteId])

  const noteCount = useMemo(() => links.filter((link) => link.itemType === 'note').length, [links])
  const eventCount = useMemo(
    () => links.filter((link) => link.itemType === 'calendar_event').length,
    [links]
  )
  const fileCount = useMemo(() => links.filter((link) => link.itemType === 'file').length, [links])

  const handleNoteClick = useCallback(
    (noteId: string): void => {
      void openRelatedVaultItem(noteId, openTab)
    },
    [openTab]
  )

  // Shortcut: jumping to the specific event/day within the calendar view
  // isn't wired yet, so this opens the calendar tab (mirrors the "open
  // calendar" shortcut in the home widget) rather than deep-linking.
  const handleEventClick = useCallback(
    (_eventId: string) => {
      openTab({
        type: 'calendar',
        title: 'Calendar',
        icon: 'calendar',
        path: '/calendar',
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      })
    },
    [openTab]
  )

  const handleToggleComplete = useCallback(
    (taskId: string): void => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return
      const taskProject = projects.find((p) => p.id === task.projectId)
      if (!taskProject) return
      const currentStatus = taskProject.statuses.find((s) => s.id === task.statusId)
      if (!currentStatus) return

      if (currentStatus.type === 'done') {
        undoable.uncompleteTask(taskId)
      } else {
        undoable.completeTask(taskId)
      }
    },
    [tasks, projects, undoable]
  )

  const handleQuickAdd = useCallback(
    (
      title: string,
      parsedData?: { dueDate: Date | null; priority: Priority; projectId: string | null }
    ): void => {
      if (!project) return
      const statusId = getDefaultTodoStatus(project)?.id || project.statuses[0]?.id
      if (!statusId) return
      const newTask = createDefaultTask(project.id, statusId, title, parsedData?.dueDate ?? null)
      if (parsedData?.priority) newTask.priority = parsedData.priority
      undoable.createTask(newTask)
    },
    [project, undoable]
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

  const ProjectIcon = getIconByName(project.icon)

  return (
    <div className={cn('flex h-full flex-col overflow-y-auto', className)}>
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        {ProjectIcon ? (
          createElement(ProjectIcon, {
            className: 'size-4 shrink-0',
            style: { color: project.color },
            'aria-hidden': 'true'
          })
        ) : (
          <span
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: project.color }}
            aria-hidden="true"
          />
        )}
        <h1 className="text-lg font-semibold text-foreground">{project.name}</h1>
      </header>

      <ProjectStatsRow
        taskCount={projectTasks.length}
        noteCount={noteCount}
        eventCount={eventCount}
        fileCount={fileCount}
        progressPct={progressPct}
      />

      <ProjectOverviewNote
        projectId={project.id}
        homeNoteId={homeNoteId}
        onHomeNoteChange={setHomeNoteId}
      />

      <TaskList
        tasks={projectTasks}
        projects={projects}
        selectedId={project.id}
        selectedType="project"
        onToggleComplete={handleToggleComplete}
        onQuickAdd={handleQuickAdd}
        onNoteClick={handleNoteClick}
      />

      <ProjectEventsSection projectId={project.id} onEventClick={handleEventClick} />

      <ProjectNotesSection projectId={project.id} onNoteClick={handleNoteClick} />

      <ProjectFilesSection projectId={project.id} onFileClick={handleNoteClick} />
    </div>
  )
}

export default ProjectHomePage
