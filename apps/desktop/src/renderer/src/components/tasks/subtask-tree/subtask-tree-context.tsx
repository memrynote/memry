import { createContext, useContext } from 'react'

/**
 * What the task rows need to work on the hierarchy below the first level:
 * adding a subtask in place, moving a task under another one, zooming into a
 * branch. Hosts without a provider (the project hub, the home widget) render
 * the same rows without those affordances.
 */
export interface SubtaskTreeValue {
  /** The `tasks.nestedSubtasks` setting. */
  allowNested: boolean
  /** Ancestors a filter shows only as context for a deeper match. */
  contextIds: ReadonlySet<string>
  /** The task whose inline "new subtask" row is open, if any. */
  draftParentId: string | null
  openDraft: (parentId: string) => void
  /** With `parentId`, closes only that task's draft: a draft that moved on stays open. */
  closeDraft: (parentId?: string) => void
  /** Whether a new subtask may go under `parentId`. */
  canAddUnder: (parentId: string) => boolean
  addSubtask: (parentId: string, title: string) => void
  /** Whether `taskId` may move under `parentId` (null: top level, always allowed). */
  canMoveUnder: (taskId: string, parentId: string | null) => boolean
  moveUnder: (taskId: string, parentId: string | null) => void
  /** Opens the "Move under…" picker for `taskId`. */
  openMoveUnder: (taskId: string) => void
  /** Scopes the list to `taskId`'s branch. */
  zoomInto: (taskId: string) => void
  /** `taskId`'s parent as loaded, or null for a top-level task. */
  parentOf: (taskId: string) => string | null
  /** Opens the task in the detail drawer. */
  openTask: (taskId: string) => void
  /** Completes the task (with its branch) or reopens it. */
  toggleComplete: (taskId: string) => void
  /** Deletes the task; one with subtasks asks what happens to them first. */
  deleteTask: (taskId: string) => void
}

export const SubtaskTreeContext = createContext<SubtaskTreeValue | null>(null)

export const useSubtaskTree = (): SubtaskTreeValue | null => useContext(SubtaskTreeContext)
