import type { SidebarSortMode } from '@memry/contracts/sidebar-sort'
import type { NoteListItem } from '@memry/contracts/notes-api'

interface Positioned {
  path: string
}

/**
 * Folder collation, unchanged from before sort modes existed.
 *
 * Plain `localeCompare` with no options — NOT base sensitivity. The two agree
 * on everything except the case tiebreak between otherwise-equal names, and
 * matching the old call exactly is the whole reason an upgrade can be claimed
 * to move nobody's list.
 */
const byName = (a: string, b: string): number => a.localeCompare(b)

function positionOf(positions: Record<string, number>, path: string): number {
  return positions[path] ?? Number.MAX_SAFE_INTEGER
}

/**
 * Note comparator for a sort mode.
 *
 * `manual` falls back to newest-first for notes with no stored position, which
 * is what the tree did before sort modes existed — so an untouched vault in
 * manual mode looks exactly as it always has.
 */
export function compareNotes(
  mode: SidebarSortMode,
  positions: Record<string, number>
): (a: NoteListItem, b: NoteListItem) => number {
  switch (mode) {
    case 'name-asc':
      return (a, b) => byName(a.title, b.title)
    case 'name-desc':
      return (a, b) => byName(b.title, a.title)
    case 'modified-desc':
      return (a, b) => b.modified.getTime() - a.modified.getTime()
    case 'modified-asc':
      return (a, b) => a.modified.getTime() - b.modified.getTime()
    case 'created-desc':
      return (a, b) => b.created.getTime() - a.created.getTime()
    case 'created-asc':
      return (a, b) => a.created.getTime() - b.created.getTime()
    case 'manual':
    default:
      return (a, b) => {
        const diff = positionOf(positions, a.path) - positionOf(positions, b.path)
        if (diff !== 0) return diff
        return b.modified.getTime() - a.modified.getTime()
      }
  }
}

/**
 * Folder comparator for a sort mode.
 *
 * Folders carry no timestamp — `FolderInfo` is `{ path, icon }`, and a folder
 * without an icon has no `folder_configs` row at all — so every time mode
 * sorts folders A→Z, in that direction regardless of the mode's own direction.
 * That is deliberate: it is what makes `modified-desc` reproduce the previous
 * tree exactly (folders A→Z, notes newest-first) so the upgrade moves nobody's
 * list. Only the name modes flip folders.
 */
export function compareFolders<T extends Positioned & { name: string }>(
  mode: SidebarSortMode,
  positions: Record<string, number>
): (a: T, b: T) => number {
  if (mode === 'name-desc') return (a, b) => byName(b.name, a.name)

  if (mode === 'manual') {
    return (a, b) => {
      const diff = positionOf(positions, a.path) - positionOf(positions, b.path)
      if (diff !== 0) return diff
      return byName(a.name, b.name)
    }
  }

  // name-asc and every time mode.
  return (a, b) => byName(a.name, b.name)
}
