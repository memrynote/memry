import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
}

const EMPTY_CONTENTS: ProjectContents = {
  notes: [],
  files: [],
  events: [],
  counts: { notes: 0, files: 0, events: 0 }
}

const EMPTY_PROGRESS: ProjectProgress = { done: 0, total: 0, pct: 0, statuses: [], overdue: 0 }

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

  const [contents, setContents] = useState<ProjectContents>(EMPTY_CONTENTS)
  const [isLoading, setIsLoading] = useState(false)
  // `undefined` = not resolved yet, so the rail does not flash a
  // "create overview note" affordance before the first response lands.
  const [homeNoteId, setHomeNoteId] = useState<string | null | undefined>(undefined)
  const [timestamps, setTimestamps] = useState<{ createdAt: Date; modifiedAt: Date } | null>(null)

  // Guards against an out-of-order response for a project the user already
  // navigated away from stomping fresher state.
  const latestRequestRef = useRef<string | undefined>(undefined)

  const project = useMemo(
    () => projects.find((candidate) => candidate.id === projectId) ?? null,
    [projects, projectId]
  )

  const projectTasks = useMemo(() => {
    if (!projectId) return []
    return getFilteredTasks(tasks, projectId, 'project', projects)
  }, [tasks, projectId, projects])

  const load = useCallback(async (): Promise<void> => {
    if (!projectId) {
      latestRequestRef.current = undefined
      setContents(EMPTY_CONTENTS)
      setHomeNoteId(null)
      setTimestamps(null)
      return
    }

    latestRequestRef.current = projectId
    setIsLoading(true)
    try {
      const [loadedContents, loadedProject] = await Promise.all([
        tasksService.listProjectContents(projectId),
        tasksService.getProject(projectId)
      ])
      if (latestRequestRef.current !== projectId) return

      setContents(loadedContents)
      setHomeNoteId(loadedProject?.homeNoteId ?? null)
      setTimestamps(
        loadedProject
          ? {
              createdAt: new Date(loadedProject.createdAt),
              modifiedAt: new Date(loadedProject.modifiedAt)
            }
          : null
      )
    } catch (error) {
      if (latestRequestRef.current !== projectId) return
      log.error('Failed to load project contents', extractErrorMessage(error))
    } finally {
      if (latestRequestRef.current === projectId) setIsLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    return onProjectUpdated((event) => {
      if (event.id === projectId) void load()
    })
  }, [projectId, load])

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
    createdAt: timestamps?.createdAt ?? null,
    modifiedAt: timestamps?.modifiedAt ?? null,
    isLoading,
    refresh: () => void load()
  }
}
