/**
 * A note's header status, derived from the tasks written in its body (#3176).
 *
 * The note's own `status` property stays on disk untouched, because builds
 * from before this rule read it. A reader that knows the tasks replaces it
 * with `deriveHeaderStatus`. The Rust core implements the same rule in
 * `crates/memry-core/src/domain/note_status.rs`. It is a read-time product rule
 * and changes no synced byte, so there is no vector: both sides test the same
 * cases, and a change to the rule changes both.
 */

/** The property that holds a note's header status, named as the default definition names it. */
export const HEADER_STATUS_PROPERTY = 'status'

export type TaskStatusCategory = 'todo' | 'in_progress' | 'done'

/** The part of a project status row the category rule reads. */
export interface TaskStatusRow {
  isDone: boolean
  isDefault: boolean
  position: number
}

/** The part of a status property's categories the option lookup reads. */
export type StatusOptionCategories = Record<
  TaskStatusCategory,
  { options: ReadonlyArray<{ value: string; default?: boolean }> }
>

/**
 * Where one task sits. A completed task is done whatever its status says. An
 * open task is to-do when it has no status row or sits on its project's first
 * default status, and in progress on any other.
 */
export function taskStatusCategory(
  task: { completed: boolean },
  status: TaskStatusRow | null
): TaskStatusCategory {
  if (task.completed || status?.isDone) return 'done'
  if (!status) return 'todo'
  return status.isDefault && status.position === 0 ? 'todo' : 'in_progress'
}

/**
 * The note's category from its tasks' categories: all to-do is to-do, all done
 * is done, anything else is in progress. A note with no tasks has none.
 */
export function deriveStatusCategory(
  categories: readonly TaskStatusCategory[]
): TaskStatusCategory | null {
  if (categories.length === 0) return null
  if (categories.every((category) => category === 'todo')) return 'todo'
  if (categories.every((category) => category === 'done')) return 'done'
  return 'in_progress'
}

/**
 * The value to show in the header: the category's default option, else its
 * first. Null when the note has no tasks or the category has no option, and the
 * stored value then stands.
 */
export function deriveHeaderStatus(
  taskCategories: readonly TaskStatusCategory[],
  statusCategories: StatusOptionCategories
): string | null {
  const category = deriveStatusCategory(taskCategories)
  if (!category) return null
  const options = statusCategories[category].options
  return (options.find((option) => option.default) ?? options[0])?.value ?? null
}
