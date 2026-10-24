import type { SidebarSortMode } from '@memry/contracts/sidebar-sort'

/**
 * Comparator for a flat sidebar list (projects, bookmarks, canvases).
 *
 * `position` is the stored manual order; `name` is what the row displays;
 * `created`/`modified` are epoch ms, or undefined on a surface that has no such
 * field — a mode reading a missing field falls back to the manual order rather
 * than producing an arbitrary shuffle. The mode lists in `SIDEBAR_SORT_MODES`
 * already keep those modes off surfaces that cannot supply them; this is the
 * belt to that suspenders.
 */
export interface SortableListItem {
  name: string
  position: number
  created?: number
  modified?: number
}

function byPosition(a: SortableListItem, b: SortableListItem): number {
  if (a.position !== b.position) return a.position - b.position
  return a.name.localeCompare(b.name)
}

export function compareListItems<T extends SortableListItem>(
  mode: SidebarSortMode
): (a: T, b: T) => number {
  switch (mode) {
    case 'name-asc':
      return (a, b) => a.name.localeCompare(b.name)
    case 'name-desc':
      return (a, b) => b.name.localeCompare(a.name)
    case 'modified-desc':
      return (a, b) =>
        a.modified === undefined || b.modified === undefined
          ? byPosition(a, b)
          : b.modified - a.modified
    case 'modified-asc':
      return (a, b) =>
        a.modified === undefined || b.modified === undefined
          ? byPosition(a, b)
          : a.modified - b.modified
    case 'created-desc':
      return (a, b) =>
        a.created === undefined || b.created === undefined
          ? byPosition(a, b)
          : b.created - a.created
    case 'created-asc':
      return (a, b) =>
        a.created === undefined || b.created === undefined
          ? byPosition(a, b)
          : a.created - b.created
    case 'manual':
    default:
      return byPosition
  }
}

/** True when the surface's rows may be dragged to reorder in this mode. */
export function isReorderable(mode: SidebarSortMode): boolean {
  return mode === 'manual'
}
