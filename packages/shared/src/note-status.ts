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

/**
 * Whether a property is the one that holds a note's header status. Case does
 * not matter: the property picker names a new one after its type, `Status`,
 * while the stock definition is `status`.
 */
export function isHeaderStatusProperty(name: string): boolean {
  return name.toLowerCase() === 'status'
}

/** The name of the note's header status property in `properties`, if it has one. */
export function findHeaderStatusProperty(properties: Record<string, unknown>): string | undefined {
  return Object.keys(properties).find(isHeaderStatusProperty)
}

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
 * Where one task sits. A done status is done. A status past the first default
 * one is in progress, whatever `completedAt` says: the status pickers change
 * the status alone and leave `completedAt` behind, so a done task moved back to
 * In Progress must read as in progress. On the first default status, or with
 * none, the task is done once it is completed (the CLI, agents, importers and
 * checkbox edits complete a task without moving its status), else to-do.
 */
export function taskStatusCategory(
  task: { completed: boolean },
  status: TaskStatusRow | null
): TaskStatusCategory {
  if (status?.isDone) return 'done'
  if (status && !(status.isDefault && status.position === 0)) return 'in_progress'
  return task.completed ? 'done' : 'todo'
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
