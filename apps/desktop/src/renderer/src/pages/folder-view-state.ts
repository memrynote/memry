/**
 * What a folder/tag view tab remembers, and how it is read back.
 *
 * Deliberately NARROW. Almost everything this page shows is already persisted
 * in the folder's own `.folder.md` through `useFolderView` — the view `type`
 * (table/list/grid), its columns, filters, `order`, `groupBy` (including
 * `collapsed`), `limit` and `showSummaries`. Mirroring any of that into tab
 * state would give one value two owners that overwrite each other on every
 * reload, so only what the FILE cannot express lives here:
 *
 * - which of the folder's named views this particular tab is looking at
 * - the transient in-page search
 *
 * The active view is stored by NAME, never by index. `useFolderView` tracks an
 * `activeViewIndex`, but indices shift the moment a view is added, deleted or
 * reordered in `.folder.md` — possibly by another device, or by hand — and a
 * stale index silently lands on someone else's view. A stale NAME just fails to
 * match, and the folder's own `defaultIndex` takes over.
 */

export const FOLDER_VIEW_STATE_KEYS = {
  /** Name of the folder's view this tab is on. `null` means "use the default". */
  viewName: 'folderViewName',
  /** In-page search text. */
  searchQuery: 'folderSearchQuery',
  /** Whether the search input is expanded. */
  searchOpen: 'folderSearchOpen'
} as const

/**
 * Each render mode owns its own scroller and a tab holds ONE scroll record, so
 * every mode stamps which one it is. Table and grouped-table are separate
 * components with different row heights, and list/gallery are not virtualized
 * at all — an offset from one is meaningless in another.
 */
export const FOLDER_SCROLL_KEYS = {
  table: 'folder-table',
  grouped: 'folder-grouped',
  list: 'folder-list',
  gallery: 'folder-gallery'
} as const

export type FolderScrollKey = (typeof FOLDER_SCROLL_KEYS)[keyof typeof FOLDER_SCROLL_KEYS]

/**
 * Which scroller is on screen. `groupBy` splits the table in two: `GroupedTable`
 * and `FolderTableView` are different components, so they must not share a key.
 */
export function folderScrollKey(viewType: string, isGrouped: boolean): FolderScrollKey {
  if (viewType === 'list') return FOLDER_SCROLL_KEYS.list
  if (viewType === 'grid') return FOLDER_SCROLL_KEYS.gallery
  return isGrouped ? FOLDER_SCROLL_KEYS.grouped : FOLDER_SCROLL_KEYS.table
}

/**
 * Persisted state can have been written by an older build, so every reader is
 * total: anything unrecognised returns `undefined` and the caller falls back.
 * `null` is a value for the view name — "no pinned view, use the default" — and
 * has to be told apart from "nothing stored".
 */
export const parseViewName = (raw: unknown): string | null | undefined =>
  raw === null || typeof raw === 'string' ? raw : undefined

export const parseSearchQuery = (raw: unknown): string | undefined =>
  typeof raw === 'string' ? raw : undefined

export const parseSearchOpen = (raw: unknown): boolean | undefined =>
  typeof raw === 'boolean' ? raw : undefined
