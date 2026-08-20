import {
  SidebarSortModesSchema,
  resolveSortMode,
  isModeAllowed,
  SIDEBAR_SORT_SURFACES,
  type SidebarSortMode,
  type SidebarSortModes,
  type SidebarSortSurface
} from '@memry/contracts/sidebar-sort'
import type { DataDb } from '../database/types'
import { getSetting, setSetting } from '../database/queries/settings'
import { syncSettingsFieldUpdate } from '../sync/local-mutations'
import { createLogger } from '../lib/logger'

const log = createLogger('SidebarSortStore')

/** Data-DB `settings` key holding the whole `{ surface: mode }` map as JSON. */
export const SIDEBAR_SORT_SETTINGS_KEY = 'sidebar.sortModes'

/**
 * Stored modes, unknown/among-them-invalid entries dropped.
 *
 * A mode a newer version offers that this build does not (or one a surface
 * stopped offering) must not fail the whole read — the surface falls back to
 * its default and every other surface keeps its setting.
 */
export function readSidebarSortModes(db: DataDb): SidebarSortModes {
  const raw = getSetting(db, SIDEBAR_SORT_SETTINGS_KEY)
  if (!raw) return {}

  try {
    const parsed = SidebarSortModesSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return {}

    const cleaned: SidebarSortModes = {}
    for (const surface of SIDEBAR_SORT_SURFACES) {
      const mode = parsed.data[surface]
      if (mode && isModeAllowed(surface, mode)) cleaned[surface] = mode
    }
    return cleaned
  } catch (err) {
    log.warn('Failed to parse stored sidebar sort modes:', err)
    return {}
  }
}

/** Every surface's effective mode, defaults filled in. */
export function readResolvedSidebarSortModes(
  db: DataDb
): Record<SidebarSortSurface, SidebarSortMode> {
  const stored = readSidebarSortModes(db)
  return Object.fromEntries(
    SIDEBAR_SORT_SURFACES.map((surface) => [surface, resolveSortMode(surface, stored[surface])])
  ) as Record<SidebarSortSurface, SidebarSortMode>
}

/**
 * Persist one surface's mode and enqueue it for sync.
 *
 * The sync field path is per surface, so a device changing `collections` and a
 * device changing `tags` at the same time both win. Writing the group in one
 * field would collapse them to one clock and lose the later merge.
 */
export function writeSidebarSortMode(
  db: DataDb,
  surface: SidebarSortSurface,
  mode: SidebarSortMode
): SidebarSortModes {
  if (!isModeAllowed(surface, mode)) {
    throw new Error(`Sort mode "${mode}" is not offered on the "${surface}" sidebar section`)
  }

  const next: SidebarSortModes = { ...readSidebarSortModes(db), [surface]: mode }
  setSetting(db, SIDEBAR_SORT_SETTINGS_KEY, JSON.stringify(next))
  syncSettingsFieldUpdate(`sidebar.sortModes.${surface}`, mode)
  return next
}
