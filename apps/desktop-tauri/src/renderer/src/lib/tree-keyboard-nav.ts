/**
 * Tree Keyboard Navigation
 *
 * Finder-style arrow-key semantics for a flattened, visible tree row list.
 * Pure: it reads rows and a key, and reports what should happen. Moving
 * focus, changing selection and toggling expansion stay with the caller.
 *
 * @module lib/tree-keyboard-nav
 */

/** One visible row, in render order. */
export interface TreeNavRow {
  id: string
  /** Depth in the tree; root rows are 0. */
  level: number
  /** Folders are expandable even while empty; notes never are. */
  isExpandable: boolean
  isExpanded: boolean
}

export type TreeNavIntent =
  /** Move focus and selection to `id`. */
  | { type: 'move'; id: string; index: number }
  | { type: 'expand'; id: string }
  | { type: 'collapse'; id: string }

const NAV_KEYS = new Set(['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'])

export function isTreeNavKey(key: string): boolean {
  return NAV_KEYS.has(key)
}

/** Index of the row `rows[index]` hangs off, or -1 at the root. */
function findParentIndex(rows: TreeNavRow[], index: number): number {
  const level = rows[index].level
  for (let i = index - 1; i >= 0; i--) {
    if (rows[i].level < level) return i
  }
  return -1
}

/**
 * Resolve one keystroke against the visible rows.
 *
 * With no current row, Down/Up enter the list at its first row so the tree is
 * reachable from an empty selection. Returns null when the key does nothing —
 * Right on a note, Left at the root — and the caller should leave the event
 * alone so the surrounding scroll container keeps its default behaviour.
 */
export function resolveTreeNavIntent(
  rows: TreeNavRow[],
  currentId: string | null,
  key: string
): TreeNavIntent | null {
  if (rows.length === 0) return null

  const currentIndex = currentId ? rows.findIndex((row) => row.id === currentId) : -1

  if (currentIndex === -1) {
    if (key !== 'ArrowDown' && key !== 'ArrowUp') return null
    return { type: 'move', id: rows[0].id, index: 0 }
  }

  const current = rows[currentIndex]

  switch (key) {
    case 'ArrowDown': {
      const next = currentIndex + 1
      return next < rows.length ? { type: 'move', id: rows[next].id, index: next } : null
    }
    case 'ArrowUp': {
      const prev = currentIndex - 1
      return prev >= 0 ? { type: 'move', id: rows[prev].id, index: prev } : null
    }
    case 'ArrowRight': {
      if (!current.isExpandable) return null
      if (!current.isExpanded) return { type: 'expand', id: current.id }
      // Already open: step into it. An expanded-but-empty folder has no child
      // row to step into, so nothing happens.
      const next = currentIndex + 1
      if (next >= rows.length || rows[next].level <= current.level) return null
      return { type: 'move', id: rows[next].id, index: next }
    }
    case 'ArrowLeft': {
      if (current.isExpandable && current.isExpanded) {
        return { type: 'collapse', id: current.id }
      }
      const parentIndex = findParentIndex(rows, currentIndex)
      return parentIndex === -1
        ? null
        : { type: 'move', id: rows[parentIndex].id, index: parentIndex }
    }
    default:
      return null
  }
}
