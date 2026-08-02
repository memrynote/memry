import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTasksContext } from '@/contexts/tasks'
import { getFilteredTasks } from '@/lib/task-utils'
import { tasksService, onProjectUpdated } from '@/services/tasks-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import type { Project, Status, StatusType } from '@/data/tasks-data'
import type { Task } from '@/data/task-model'
import type {
  ProjectContents,
  ProjectLinkedEvent,
  ProjectLinkedFile,
  ProjectLinkedNote
} from '@memry/rpc/tasks'

const log = createLogger('ProjectHub')

export type ProjectTabKey = 'overview' | 'tasks' | 'notes' | 'files' | 'events'

export interface ProjectStatusProgress {
  id: string
  name: string
  color: string
  type: StatusType
  count: number
}

export interface ProjectProgress {
  done: number
  total: number
  pct: number
  statuses: ProjectStatusProgress[]
  overdue: number
}

export interface ProjectHubData {
  project: Project | null
  tasks: Task[]
  notes: ProjectLinkedNote[]
  pinnedNotes: ProjectLinkedNote[]
  files: ProjectLinkedFile[]
  events: ProjectLinkedEvent[]
  counts: { tasks: number; notes: number; files: number; events: number }
  progress: ProjectProgress
  homeNoteId: string | null | undefined
  createdAt: Date | null
  modifiedAt: Date | null
  isLoading: boolean
  refresh: () => void
  setHomeNoteId: (noteId: string | null) => void
}

const EMPTY_CONTENTS: ProjectContents = {
  notes: [],
  files: [],
  events: [],
  counts: { notes: 0, files: 0, events: 0 }
}

const EMPTY_PROGRESS: ProjectProgress = { done: 0, total: 0, pct: 0, statuses: [], overdue: 0 }

interface LoadedProject {
  projectId: string
  contents: ProjectContents
  homeNoteId: string | null
  createdAt: Date | null
  modifiedAt: Date | null
}

const byOrder = (a: Status, b: Status): number => a.order - b.order

/**
 * Progress for the hub's rail, derived entirely from the project's own status
 * configuration — a project with four in-progress statuses gets four rows.
 *
 * "Done" comes from the status type rather than `completedAt`, so a task in a
 * done-type status counts even when the timestamp was never stamped.
 */
export function deriveProgress(project: Project | null, tasks: Task[]): ProjectProgress {
  if (!project) return EMPTY_PROGRESS

  const statusById = new Map(project.statuses.map((status) => [status.id, status]))
  const counts = new Map<string, number>()
  for (const status of project.statuses) counts.set(status.id, 0)

  // Local midnight: a task due earlier today is due, not overdue.
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)

  let done = 0
  let overdue = 0

  for (const task of tasks) {
    const status = statusById.get(task.statusId)
    if (status) counts.set(status.id, (counts.get(status.id) ?? 0) + 1)

    const isDone = status?.type === 'done'
    if (isDone) done += 1
    else if (task.dueDate && task.dueDate.getTime() < startOfToday.getTime()) overdue += 1
  }

  const total = tasks.length

  return {
    done,
    total,
    pct: total === 0 ? 0 : Math.round((done / total) * 100),
    statuses: [...project.statuses].sort(byOrder).map((status) => ({
      id: status.id,
      name: status.name,
      color: status.color,
      type: status.type,
      count: counts.get(status.id) ?? 0
    })),
    overdue
  }
}

/**
 * The project hub's single data source. One `listProjectContents` call resolves
 * every linked note, file and event; tasks come from the shared tasks context.
 */
export function useProjectHub(projectId: string | undefined): ProjectHubData {
  const { tasks, projects } = useTasksContext()

  // One state slot holding the project the data belongs to. Keeping the id with
  // the payload means "is this stale?" is a comparison at render time instead of
  // a pile of resets whenever the prop changes.
  const [loaded, setLoaded] = useState<LoadedProject | null>(null)
  // Bumped by refresh() and by PROJECT_UPDATED; re-runs the effect below.
  const [reloadToken, setReloadToken] = useState(0)

  const project = useMemo(
    () => projects.find((candidate) => candidate.id === projectId) ?? null,
    [projects, projectId]
  )

  const projectTasks = useMemo(() => {
    if (!projectId) return []
    return getFilteredTasks(tasks, projectId, 'project', projects)
  }, [tasks, projectId, projects])

  useEffect(() => {
    if (!projectId) return

    // Cancellation is per effect run, so a response for a project the user has
    // already navigated away from can never be stored.
    let cancelled = false

    void (async () => {
      try {
        const [contents, loadedProject] = await Promise.all([
          tasksService.listProjectContents(projectId),
          tasksService.getProject(projectId)
        ])
        if (cancelled) return

        setLoaded({
          projectId,
          contents,
          homeNoteId: loadedProject?.homeNoteId ?? null,
          createdAt: loadedProject ? new Date(loadedProject.createdAt) : null,
          modifiedAt: loadedProject ? new Date(loadedProject.modifiedAt) : null
        })
      } catch (error) {
        if (cancelled) return
        log.error('Failed to load project contents', extractErrorMessage(error))
        // `isLoading` is derived from "no payload for this project", so leaving
        // the slot empty would pin the hub on its skeleton for good. An empty
        // payload renders the page instead, and refresh() can still retry.
        setLoaded({
          projectId,
          contents: EMPTY_CONTENTS,
          homeNoteId: null,
          createdAt: null,
          modifiedAt: null
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [projectId, reloadToken])

  const refresh = useCallback(() => setReloadToken((token) => token + 1), [])

  // The overview note reports its new id the moment it creates or clears one.
  // Applying it locally keeps the rail from showing the "create" affordance
  // again for the length of the refetch that follows.
  const setHomeNoteId = useCallback(
    (noteId: string | null) => {
      setLoaded((current) =>
        current && current.projectId === projectId ? { ...current, homeNoteId: noteId } : current
      )
    },
    [projectId]
  )

  useEffect(() => {
    return onProjectUpdated((event) => {
      if (event.id === projectId) refresh()
    })
  }, [projectId, refresh])

  // Everything below is derived: a payload for a different project is stale and
  // reads as "still loading" rather than briefly showing the previous project.
  const fresh = loaded?.projectId === projectId ? loaded : null
  const contents = fresh?.contents ?? EMPTY_CONTENTS
  // `undefined` = not resolved yet, so the rail does not flash a
  // "create overview note" affordance before the first response lands.
  const homeNoteId = fresh ? fresh.homeNoteId : undefined
  const isLoading = projectId != null && fresh === null

  const pinnedNotes = useMemo(() => contents.notes.filter((note) => note.pinned), [contents.notes])

  const progress = useMemo(() => deriveProgress(project, projectTasks), [project, projectTasks])

  return {
    project,
    tasks: projectTasks,
    notes: contents.notes,
    pinnedNotes,
    files: contents.files,
    events: contents.events,
    counts: {
      tasks: projectTasks.length,
      notes: contents.counts.notes,
      files: contents.counts.files,
      events: contents.counts.events
    },
    progress,
    homeNoteId,
    createdAt: fresh?.createdAt ?? null,
    modifiedAt: fresh?.modifiedAt ?? null,
    isLoading,
    refresh,
    setHomeNoteId
  }
}
