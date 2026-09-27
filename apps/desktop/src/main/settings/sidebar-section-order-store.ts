import type { DataDb } from '../database/types'
import { getSetting, setSetting } from '../database/queries/settings'
import { syncSettingsFieldUpdate } from '../sync/local-mutations'
import { createLogger } from '../lib/logger'

const log = createLogger('SidebarSectionOrderStore')

/** Data-DB `settings` key holding the section ids as a JSON array. */
export const SIDEBAR_SECTION_ORDER_SETTINGS_KEY = 'sidebar.sectionOrder'

/**
 * The ids the user dragged into place, or `[]` when they never have.
 *
 * Ids are kept verbatim: which sections exist is the renderer's business (a
 * feature flag can take one away at any time), and dropping an id here would
 * quietly forget the position of a section that is only temporarily gone.
 * Anything that is not an array of strings reads as "never reordered".
 */
export function readSidebarSectionOrder(db: DataDb): string[] {
  return readIdList(db, SIDEBAR_SECTION_ORDER_SETTINGS_KEY)
}

/** Rail page ids (home, inbox, ...) in the order the user dragged them; same rules as sections. */
export const SIDEBAR_RAIL_ORDER_SETTINGS_KEY = 'sidebar.railOrder'

export function readSidebarRailOrder(db: DataDb): string[] {
  return readIdList(db, SIDEBAR_RAIL_ORDER_SETTINGS_KEY)
}

export function writeSidebarRailOrder(db: DataDb, order: string[]): string[] {
  return writeIdList(db, SIDEBAR_RAIL_ORDER_SETTINGS_KEY, order)
}

function readIdList(db: DataDb, key: string): string[] {
  const raw = getSetting(db, key)
  if (!raw) return []

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string')
  } catch (err) {
    log.warn(`Failed to parse stored ${key}:`, err)
    return []
  }
}

/**
 * Persist the order and enqueue it for sync.
 *
 * One field path for the whole list, unlike `sidebar.sortModes.<surface>`:
 * reordering moves every section at once, so two devices dragging concurrently
 * have to resolve to one of the two orders. Per-entry clocks would merge them
 * into a third order neither user asked for.
 */
export function writeSidebarSectionOrder(db: DataDb, order: string[]): string[] {
  return writeIdList(db, SIDEBAR_SECTION_ORDER_SETTINGS_KEY, order)
}

function writeIdList(db: DataDb, key: string, order: string[]): string[] {
  const next = order.filter((id): id is string => typeof id === 'string')
  setSetting(db, key, JSON.stringify(next))
  syncSettingsFieldUpdate(key, next)
  return next
}
