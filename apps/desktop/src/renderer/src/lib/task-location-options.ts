import type { Task } from '@/data/task-model'
import type { TaskNoteIndex } from '@/lib/task-note-index'

/** One row of the Location filter panel: a folder or a note that has tasks. */
export interface TaskLocationOption {
  kind: 'folder' | 'note'
  /** Folder path or note id: the value the filter stores. */
  value: string
  label: string
  /** Folder a note sits in, or a folder's parent path. Shown while searching. */
  context: string
  /** Nesting below the vault root, for the tree indent. */
  depth: number
  /** Top-level tasks the row would select. */
  count: number
  /** A note's own icon, if set. Folder icons come from the folder config. */
  icon?: string | null
}

const taskNoteIds = (task: Task): string[] =>
  task.sourceNoteId ? [task.sourceNoteId, ...task.linkedNoteIds] : task.linkedNoteIds

const ancestorsOf = (folderPath: string): string[] => {
  if (!folderPath) return []
  const parts = folderPath.split('/')
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}

const parentOf = (path: string): string => path.split('/').slice(0, -1).join('/')

// Within a folder its notes come first, then its subfolders, matching how the
// filter reads: "this folder" and then "deeper". `\u0000` sorts before every
// visible character, so a folder's notes land right under it.
const folderSortKey = (folderPath: string): string => `${folderPath.toLowerCase()}/`
const noteSortKey = (folderPath: string, title: string): string =>
  `${folderPath ? `${folderPath.toLowerCase()}/` : ''}\u0000${title.toLowerCase()}`

/**
 * Folders and notes that hold at least one of `tasks`, as a tree in display
 * order. Selected entries stay listed even when nothing in `tasks` is filed
 * there any more, so they can still be unchecked.
 *
 * With a `query` the tree flattens to the rows whose name matches it.
 */
export const buildTaskLocationOptions = (
  tasks: Task[],
  noteIndex: TaskNoteIndex,
  selected: { folderPaths: readonly string[]; noteIds: readonly string[] },
  query: string
): TaskLocationOption[] => {
  const noteTasks = new Map<string, Set<string>>()
  const folderTasks = new Map<string, Set<string>>()
  const add = (map: Map<string, Set<string>>, key: string, taskId: string): void => {
    const set = map.get(key)
    if (set) set.add(taskId)
    else map.set(key, new Set([taskId]))
  }

  for (const task of tasks) {
    if (task.parentId !== null) continue
    for (const noteId of taskNoteIds(task)) {
      const info = noteIndex.get(noteId)
      if (!info) continue
      add(noteTasks, noteId, task.id)
      for (const folder of ancestorsOf(info.folderPath)) add(folderTasks, folder, task.id)
    }
  }

  for (const folderPath of selected.folderPaths) {
    for (const folder of ancestorsOf(folderPath)) {
      if (!folderTasks.has(folder)) folderTasks.set(folder, new Set())
    }
  }

  const rows: Array<TaskLocationOption & { sortKey: string }> = []

  for (const [folderPath, ids] of folderTasks) {
    rows.push({
      kind: 'folder',
      value: folderPath,
      label: folderPath.split('/').pop() ?? folderPath,
      context: parentOf(folderPath),
      depth: folderPath.split('/').length - 1,
      count: ids.size,
      sortKey: folderSortKey(folderPath)
    })
  }

  const noteIds = new Set([...noteTasks.keys(), ...selected.noteIds])
  for (const noteId of noteIds) {
    const info = noteIndex.get(noteId)
    if (!info) continue
    rows.push({
      kind: 'note',
      value: noteId,
      label: info.title,
      context: info.folderPath,
      depth: info.folderPath ? info.folderPath.split('/').length : 0,
      count: noteTasks.get(noteId)?.size ?? 0,
      icon: info.icon,
      sortKey: noteSortKey(info.folderPath, info.title)
    })
  }

  rows.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))

  const needle = query.trim().toLowerCase()
  const visible = needle ? rows.filter((row) => row.label.toLowerCase().includes(needle)) : rows

  return visible.map(({ sortKey: _sortKey, ...row }) => (needle ? { ...row, depth: 0 } : row))
}
