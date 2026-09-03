import type { IconName } from '@/components/ui/icon'

/**
 * What a long press on a notes-tree row offers (boards 26B / 26C).
 *
 * A TABLE, not a component that branches. The menu, the tests and any future
 * surface that wants the same verbs (a swipe strip, a `···` sheet) all read
 * this one list, so "does a folder offer Duplicate?" has exactly one answer in
 * the codebase instead of one per renderer.
 *
 * Nothing here touches SQLite, React or the sync queue: it is a function of the
 * row and two booleans.
 */

export type RowTarget =
  | { kind: 'note'; id: string; title: string; folderPath: string }
  /** `path` is the full folder path; `''` is never a target (the root has no row). */
  | { kind: 'folder'; path: string; name: string; noteCount: number }

export type RowActionId =
  | 'new-note'
  | 'new-folder'
  | 'duplicate'
  | 'move'
  | 'search-in-folder'
  | 'bookmark'
  | 'unbookmark'
  | 'share'
  | 'rename'
  | 'delete'

export interface RowAction {
  id: RowActionId
  label: string
  icon: IconName
  /** Draws in the destructive colour and sits alone in the last group. */
  destructive?: true
}

/**
 * Groups, iOS-menu style: create, edit, find, destroy. The board draws an 8pt
 * band between them, so the grouping is data rather than a divider the
 * renderer has to know where to insert.
 */
export type RowActionGroups = RowAction[][]

export interface RowActionOptions {
  /** The row's item is already bookmarked, so the verb flips. */
  bookmarked: boolean
  /**
   * Read-only mode (a flipped kill switch or a raised version floor). Every
   * WRITE disappears; the read verbs stay, because refusing to let someone
   * search a folder because the server said "no writes" is nonsense.
   */
  readOnly: boolean
}

const NOTE_EDIT: readonly RowAction[] = [
  { id: 'duplicate', label: 'Duplicate', icon: 'copy' },
  { id: 'move', label: 'Move to folder…', icon: 'folder-input' },
  { id: 'rename', label: 'Rename', icon: 'pencil' }
]

const FOLDER_CREATE: readonly RowAction[] = [
  { id: 'new-note', label: 'New note', icon: 'file-plus' },
  { id: 'new-folder', label: 'New folder', icon: 'folder-plus' }
]

const FOLDER_EDIT: readonly RowAction[] = [
  { id: 'duplicate', label: 'Duplicate', icon: 'copy' },
  { id: 'move', label: 'Move folder to…', icon: 'folder-input' },
  { id: 'rename', label: 'Rename', icon: 'pencil' }
]

function bookmarkAction(bookmarked: boolean): RowAction {
  return bookmarked
    ? { id: 'unbookmark', label: 'Remove from bookmarks', icon: 'bookmark-off' }
    : { id: 'bookmark', label: 'Add to bookmarks', icon: 'bookmark' }
}

function nonEmpty(groups: RowActionGroups): RowActionGroups {
  return groups.filter((group) => group.length > 0)
}

export function rowActionGroups(target: RowTarget, opts: RowActionOptions): RowActionGroups {
  const writable = !opts.readOnly

  if (target.kind === 'folder') {
    return nonEmpty([
      writable ? [...FOLDER_CREATE] : [],
      writable ? [...FOLDER_EDIT] : [],
      [
        { id: 'search-in-folder', label: 'Search in folder', icon: 'search' },
        bookmarkAction(opts.bookmarked)
      ],
      writable ? [{ id: 'delete', label: 'Delete folder', icon: 'trash', destructive: true }] : []
    ])
  }

  return nonEmpty([
    writable ? [...NOTE_EDIT] : [],
    [{ id: 'share', label: 'Share a copy', icon: 'share' }, bookmarkAction(opts.bookmarked)],
    writable ? [{ id: 'delete', label: 'Delete note', icon: 'trash', destructive: true }] : []
  ])
}

/** The bookmark row identity for a target, matching desktop's polymorphic pair. */
export function bookmarkRefFor(target: RowTarget): { itemType: 'note' | 'folder'; itemId: string } {
  return target.kind === 'note'
    ? { itemType: 'note', itemId: target.id }
    : { itemType: 'folder', itemId: target.path }
}

/** The label the row shows while the menu is open, and in every confirm copy. */
export function targetLabel(target: RowTarget): string {
  return target.kind === 'note' ? target.title : target.name
}
