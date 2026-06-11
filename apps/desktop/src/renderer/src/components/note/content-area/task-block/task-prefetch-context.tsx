import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import { tasksService, type Task } from '@/services/tasks-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('TaskPrefetch')

interface TaskPrefetchValue {
  /** 'loading' until the note's linked tasks have been fetched (or failed). */
  status: 'loading' | 'ready'
  /** Returns a prefetched task by id, or undefined if not in the batch. */
  getCached: (taskId: string) => Task | undefined
}

// Default used when a taskBlock renders outside a provider (e.g. unit tests):
// behaves as an always-empty, already-settled cache so blocks fall back to
// their own fetch.
const DEFAULT_VALUE: TaskPrefetchValue = {
  status: 'ready',
  getCached: () => undefined
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

  // Data-fetch effect: linked tasks must be re-fetched whenever the note
  // changes, and the cache state they populate isn't derivable during render —
  // the legitimate exception to no-adjust-state-on-prop-change.
  /* eslint-disable react-you-might-not-need-an-effect/no-adjust-state-on-prop-change */
  useEffect(() => {
    let cancelled = false
    setTasksById(new Map())

    if (!noteId) {
      setStatus('ready')
      return
    }

    setStatus('loading')
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
  /* eslint-enable react-you-might-not-need-an-effect/no-adjust-state-on-prop-change */

  const value = useMemo<TaskPrefetchValue>(
    () => ({ status, getCached: (taskId: string) => tasksById.get(taskId) }),
    [status, tasksById]
  )

  return <TaskPrefetchContext.Provider value={value}>{children}</TaskPrefetchContext.Provider>
}
