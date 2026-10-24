import { createContext, useContext } from 'react'

/**
 * A list's expanded parents, for rows at any depth: the virtualized lists own
 * the state (`useExpandedTasks`) and nested rows read it from here instead of
 * through every level of props.
 */
export interface TaskExpansionValue {
  expandedIds: ReadonlySet<string>
  toggle: (taskId: string) => void
  /** Idempotent, unlike `toggle`. */
  expand: (taskId: string) => void
}

export const TaskExpansionContext = createContext<TaskExpansionValue | null>(null)

export const useTaskExpansion = (): TaskExpansionValue | null => useContext(TaskExpansionContext)
