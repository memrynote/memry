/**
 * Every task property the inline block can open a picker for. Status, priority
 * and project can never be empty, so they are permanent controls in the row;
 * the rest show as a chip only while they carry a value (or while their picker
 * is open), and live in the add menu otherwise.
 *
 * `start` and `due` are two ids for the one dates chip: which one opened it
 * decides the segment its picker starts on.
 */
export type TaskPropertyId =
  | 'status'
  | 'priority'
  | 'project'
  | 'due'
  | 'start'
  | 'repeat'
  | 'reminder'
  | 'tags'
  | 'description'
  | 'related'

export type OptionalTaskPropertyId = Exclude<TaskPropertyId, 'status' | 'priority' | 'project'>

/**
 * One variable for the whole surface: which picker is open. Opening one closes
 * whatever was open, so at most one popover is ever on screen.
 */
export interface TaskPropertyOpenState {
  open: TaskPropertyId | null
  onOpenChange: (id: TaskPropertyId, open: boolean) => void
}

interface PropertyShortcut {
  id: TaskPropertyId
  key: string
  shift: boolean
  /** What the key hint shows. */
  label: string
}

/**
 * Single keys, live while the block (not its title input) has focus. Shift
 * pairs a property with its sibling: D due / ⇧D start, P priority / ⇧P
 * project, L tags / ⇧L related.
 */
export const TASK_PROPERTY_SHORTCUTS: readonly PropertyShortcut[] = [
  { id: 'status', key: 's', shift: false, label: 'S' },
  { id: 'priority', key: 'p', shift: false, label: 'P' },
  { id: 'project', key: 'p', shift: true, label: '⇧P' },
  { id: 'due', key: 'd', shift: false, label: 'D' },
  { id: 'start', key: 'd', shift: true, label: '⇧D' },
  { id: 'repeat', key: 'r', shift: false, label: 'R' },
  { id: 'reminder', key: 'h', shift: false, label: 'H' },
  { id: 'tags', key: 'l', shift: false, label: 'L' },
  { id: 'description', key: 'e', shift: false, label: 'E' },
  { id: 'related', key: 'l', shift: true, label: '⇧L' }
]

export const shortcutLabelFor = (id: TaskPropertyId): string =>
  TASK_PROPERTY_SHORTCUTS.find((shortcut) => shortcut.id === id)?.label ?? ''

/**
 * The property a keystroke names, or null. Modified keys are never shortcuts:
 * ⌘L, ⌥D and friends belong to the app and the OS.
 */
export const resolvePropertyShortcut = (event: {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}): TaskPropertyId | null => {
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  if (event.key.length !== 1) return null
  const key = event.key.toLowerCase()
  const match = TASK_PROPERTY_SHORTCUTS.find(
    (shortcut) => shortcut.key === key && shortcut.shift === event.shiftKey
  )
  return match?.id ?? null
}
