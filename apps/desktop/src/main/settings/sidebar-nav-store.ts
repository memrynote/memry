import type { DataDb } from '../database/types'
import { getSetting, setSetting } from '../database/queries/settings'
import { syncSettingsFieldUpdate } from '../sync/local-mutations'
import { createLogger } from '../lib/logger'

const log = createLogger('SidebarNavStore')

/** Data-DB `settings` key holding the collapsed flag as a JSON boolean. */
export const SIDEBAR_NAV_COLLAPSED_SETTINGS_KEY = 'sidebar.navCollapsed'

/**
 * Whether the user collapsed the sidebar's top nav block.
 *
 * Anything that is not the literal `true` reads as expanded: an absent row is
 * every install written before this toggle existed, and a corrupted value
 * should leave the nav on screen rather than hide the only way back to it.
 */
export function readSidebarNavCollapsed(db: DataDb): boolean {
  const raw = getSetting(db, SIDEBAR_NAV_COLLAPSED_SETTINGS_KEY)
  if (!raw) return false

  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed === true
  } catch (err) {
    log.warn('Failed to parse stored sidebar nav collapsed flag:', err)
    return false
  }
}

/**
 * Persist the flag and enqueue it for sync.
 *
 * One field path for the whole block, like `sidebar.sectionOrder`: collapsing
 * hides every nav row at once, so there is no per-row state two devices could
 * merge into a state neither of them asked for.
 */
export function writeSidebarNavCollapsed(db: DataDb, collapsed: boolean): boolean {
  setSetting(db, SIDEBAR_NAV_COLLAPSED_SETTINGS_KEY, JSON.stringify(collapsed))
  syncSettingsFieldUpdate(SIDEBAR_NAV_COLLAPSED_SETTINGS_KEY, collapsed)
  return collapsed
}
