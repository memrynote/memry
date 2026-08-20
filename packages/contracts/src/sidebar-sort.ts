import { z } from 'zod'

/**
 * Sidebar sort modes — the five sidebar sections each pick one.
 *
 * `manual` means "use the stored per-item order". It is only offered on a
 * surface that actually persists one; a surface without stored positions must
 * not list it, or the user picks a mode that changes nothing.
 *
 * Time modes sort NOTES only. Folders carry no timestamp anywhere in the tree
 * payload (`FolderInfo` is `{ path, icon }`), so they stay A→Z under every time
 * mode, in that direction regardless of the mode's own direction. That is what
 * makes `modified-desc` reproduce the pre-existing tree exactly — folders A→Z,
 * notes newest-first — so shipping this feature moves nobody's list.
 */
export const SidebarSortModeSchema = z.enum([
  'manual',
  'name-asc',
  'name-desc',
  'modified-desc',
  'modified-asc',
  'created-desc',
  'created-asc',
  // Tags only: tags have no created/modified, but do carry a usage count.
  'count-desc',
  'count-asc'
])

export type SidebarSortMode = z.infer<typeof SidebarSortModeSchema>

export const SIDEBAR_SORT_SURFACES = [
  'collections',
  'projects',
  'bookmarks',
  'canvases',
  'tags'
] as const

export type SidebarSortSurface = (typeof SIDEBAR_SORT_SURFACES)[number]

export const SidebarSortSurfaceSchema = z.enum(SIDEBAR_SORT_SURFACES)

/**
 * Modes each surface offers, in menu order.
 *
 * `canvases` omits `manual`: canvases and canvas_folders have no position
 * column, so there is no stored order to return to. It joins when that column
 * does.
 */
export const SIDEBAR_SORT_MODES: Record<SidebarSortSurface, readonly SidebarSortMode[]> = {
  collections: [
    'manual',
    'name-asc',
    'name-desc',
    'modified-desc',
    'modified-asc',
    'created-desc',
    'created-asc'
  ],
  // No modified modes: the renderer's Project carries `createdAt` and no
  // modification timestamp, and a Bookmark carries only `createdAt` too. A
  // mode whose field the surface cannot supply would sort by nothing.
  projects: ['manual', 'name-asc', 'name-desc', 'created-desc', 'created-asc'],
  bookmarks: ['manual', 'name-asc', 'name-desc', 'created-desc', 'created-asc'],
  canvases: [
    'name-asc',
    'name-desc',
    'modified-desc',
    'modified-asc',
    'created-desc',
    'created-asc'
  ],
  tags: ['manual', 'name-asc', 'name-desc', 'count-desc', 'count-asc']
} as const

/**
 * Each surface's default is whatever that surface already did before sort modes
 * existed, so an upgrade is invisible:
 *   collections — stored position, then folders A→Z + notes newest-first
 *   projects    — `orderBy(asc(projects.position))`
 *   bookmarks   — `orderBy(asc(bookmarks.position))`
 *   canvases    — `localeCompare` on the label
 *   tags        — the localStorage default, 'manual'
 */
export const SIDEBAR_SORT_DEFAULTS: Record<SidebarSortSurface, SidebarSortMode> = {
  // 'manual', NOT a time mode: the pre-sort-mode tree comparator read the stored
  // position first and only fell back to newest-first, which is exactly what
  // 'manual' does. A time mode ignores positions outright, so it would look
  // identical on a vault nobody has reordered and silently discard the order on
  // a vault somebody has.
  collections: 'manual',
  projects: 'manual',
  bookmarks: 'manual',
  canvases: 'name-asc',
  tags: 'manual'
} as const

export const SidebarSortModesSchema = z.object({
  collections: SidebarSortModeSchema.optional(),
  projects: SidebarSortModeSchema.optional(),
  bookmarks: SidebarSortModeSchema.optional(),
  canvases: SidebarSortModeSchema.optional(),
  tags: SidebarSortModeSchema.optional()
})

export type SidebarSortModes = z.infer<typeof SidebarSortModesSchema>

export function isModeAllowed(surface: SidebarSortSurface, mode: SidebarSortMode): boolean {
  return SIDEBAR_SORT_MODES[surface].includes(mode)
}

/** Falls back to the surface's default for an absent or not-offered mode. */
export function resolveSortMode(
  surface: SidebarSortSurface,
  stored: SidebarSortMode | undefined
): SidebarSortMode {
  if (stored && isModeAllowed(surface, stored)) return stored
  return SIDEBAR_SORT_DEFAULTS[surface]
}
