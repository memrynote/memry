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
 * `note_positions` key of the marker that says a level is ordered as one list.
 *
 * By default a level draws its folders and its notes as two groups
 * (`sidebar.notesFirst` picks which comes first). Once the user drops a folder
 * among notes, or a note among folders, the level's positions are rewritten as
 * one sequence and this row is added beside them. Root is `/`. No real item
 * path ends in `/`, so the key never collides with a note or a folder.
 *
 * Persisted format: the row lives in the local-only data DB and never syncs.
 * Older builds read it as the position of a path no item has and ignore it.
 * Main re-keys and drops it with its folder, since it sits under the folder's
 * `<path>/` prefix (`carryFolderPositions`, `dropFolderPositions`).
 */
export function mixedOrderMarkerPath(parentPath: string): string {
  return `${parentPath}/`
}

/** Parent paths of every level that carries a mixed-order marker. */
export function mixedOrderLevels(positions: Record<string, number>): Set<string> {
  const levels = new Set<string>()
  for (const key of Object.keys(positions)) {
    if (key.endsWith('/')) levels.add(key.slice(0, -1))
  }
  return levels
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
