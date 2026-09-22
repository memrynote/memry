import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import { tasksService, onProjectUpdated, type Task } from '@/services/tasks-service'
import { useTasksOptional } from '@/contexts/tasks'
import {
  loadNoteTaskProjectContext,
  resolveNoteTaskProjectId,
  type NoteTaskProjectContext
} from '@/lib/note-task-project'
import { createLogger } from '@/lib/logger'

const log = createLogger('TaskPrefetch')

const EMPTY_PROJECT_CONTEXT: NoteTaskProjectContext = {
  noteProjectIds: [],
  settingsDefaultProjectId: null
}

interface TaskPrefetchValue {
  /** 'loading' until the note's linked tasks have been fetched (or failed). */
  status: 'loading' | 'ready'
  /** Returns a prefetched task by id, or undefined if not in the batch. */
  getCached: (taskId: string) => Task | undefined
  /**
   * The project a task block drafted in this note would be created in, so a
   * draft row shows the project badge and statuses it is about to get rather
   * than the inbox's (#2271). Null outside a note or before it resolves.
   */
  draftProjectId: string | null
}

// Default used when a taskBlock renders outside a provider (e.g. unit tests):
// behaves as an always-empty, already-settled cache so blocks fall back to
// their own fetch.
const DEFAULT_VALUE: TaskPrefetchValue = {
  status: 'ready',
  getCached: () => undefined,
  draftProjectId: null
}

const TaskPrefetchContext = createContext<TaskPrefetchValue>(DEFAULT_VALUE)

export function useTaskPrefetch(): TaskPrefetchValue {
  return useContext(TaskPrefetchContext)
}

/**
 * Fetches every task linked to the note in a single IPC call and exposes them
 * as a synchronous cache. Without this, each taskBlock independently calls
 * `tasksService.get`, so N tasks resolve at different times and the rows fill in
 * "line by line". With it, all blocks read from the one batch and render their
 * status/priority/project together.
 */
export function TaskPrefetchProvider({
  noteId,
  children
}: {
  noteId?: string
  children: ReactNode
}): ReactElement {
  const [tasksById, setTasksById] = useState<Map<string, Task>>(() => new Map())
  const [status, setStatus] = useState<'loading' | 'ready'>('loading')
  const [projectContext, setProjectContext] =
    useState<NoteTaskProjectContext>(EMPTY_PROJECT_CONTEXT)
  const [prevNoteId, setPrevNoteId] = useState(noteId)
  const tasksCtx = useTasksOptional()

  // Clear the cache synchronously when the note changes, at render time rather
  // than in an effect, so blocks never read another note's tasks for a frame.
  if (noteId !== prevNoteId) {
    setPrevNoteId(noteId)
    setTasksById(new Map())
    setProjectContext(EMPTY_PROJECT_CONTEXT)
    setStatus(noteId ? 'loading' : 'ready')
  }

  // Data-fetch effect: linked tasks are re-fetched whenever the note changes;
  // the cache they populate isn't derivable during render. Only the async
  // callbacks set state here, so this is not a synchronous prop-driven reset.
  useEffect(() => {
    if (!noteId) return

    let cancelled = false
    void (async () => {
      try {
        const tasks = await tasksService.getLinkedTasks(noteId)
        if (cancelled) return
        setTasksById(new Map(tasks.map((t) => [t.id, t])))
      } catch (err) {
        // Non-fatal: blocks fall back to their own fetch on a cache miss.
        log.warn('Failed to prefetch linked tasks', err)
      } finally {
        if (!cancelled) setStatus('ready')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [noteId])

  // The note's project links and the settings default, the two note-scoped
  // halves of where a new task block would land. Read here rather than per
  // block so N drafts cost one pair of IPC calls.
  useEffect(() => {
    if (!noteId) return

    let cancelled = false
    const load = (): void => {
      void loadNoteTaskProjectContext(noteId).then((context) => {
        if (!cancelled) setProjectContext(context)
      })
    }
    load()

    // The `project` property is stored as project links, so editing it lands
    // here as a project update. Without this subscription a draft row keeps
    // showing the project the note had when it was opened.
    const unsubscribe = onProjectUpdated(load)

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [noteId])

  const projects = tasksCtx?.projects
  const draftProjectId = useMemo(
    () =>
      noteId ? resolveNoteTaskProjectId({ ...projectContext, projects: projects ?? [] }) : null,
    [noteId, projectContext, projects]
  )

  const value = useMemo<TaskPrefetchValue>(
    () => ({ status, getCached: (taskId: string) => tasksById.get(taskId), draftProjectId }),
    [status, tasksById, draftProjectId]
  )

  return <TaskPrefetchContext.Provider value={value}>{children}</TaskPrefetchContext.Provider>
}
