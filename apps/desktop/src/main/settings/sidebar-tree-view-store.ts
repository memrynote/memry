import type { DataDb } from '../database/types'
import { getSetting, setSetting } from '../database/queries/settings'
import { syncSettingsFieldUpdate } from '../sync/local-mutations'
import { createLogger } from '../lib/logger'

const log = createLogger('SidebarTreeViewStore')

/** Data-DB `settings` key: whether a folder's notes render before its subfolders. */
export const SIDEBAR_NOTES_FIRST_SETTINGS_KEY = 'sidebar.notesFirst'

/** Data-DB `settings` key: whether non-markdown vault files render in the tree. */
export const SIDEBAR_SHOW_FILES_SETTINGS_KEY = 'sidebar.showFiles'

/**
 * A stored JSON boolean, or `fallback` for anything else.
 *
 * An absent row is every install written before these toggles existed, and a
 * corrupted value should leave the tree the way it has always looked rather
 * than reorder or hide rows nobody asked to move.
 */
function readFlag(db: DataDb, key: string, fallback: boolean): boolean {
  const raw = getSetting(db, key)
  if (!raw) return fallback

  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'boolean' ? parsed : fallback
  } catch (err) {
    log.warn(`Failed to parse stored ${key}:`, err)
    return fallback
  }
}

/**
 * Persist a flag and enqueue it for sync under its own field path, like
 * `sidebar.navCollapsed`: each toggle is one whole-tree choice, so there is no
 * partial state two devices could merge into something neither asked for.
 */
function writeFlag(db: DataDb, key: string, value: boolean): boolean {
  setSetting(db, key, JSON.stringify(value))
  syncSettingsFieldUpdate(key, value)
  return value
}

/** Off unless stored: folders-first is the order every earlier build drew. */
export function readSidebarNotesFirst(db: DataDb): boolean {
  return readFlag(db, SIDEBAR_NOTES_FIRST_SETTINGS_KEY, false)
}

export function writeSidebarNotesFirst(db: DataDb, notesFirst: boolean): boolean {
  return writeFlag(db, SIDEBAR_NOTES_FIRST_SETTINGS_KEY, notesFirst)
}

/** On unless stored: every earlier build listed files in the tree. */
export function readSidebarShowFiles(db: DataDb): boolean {
  return readFlag(db, SIDEBAR_SHOW_FILES_SETTINGS_KEY, true)
}

export function writeSidebarShowFiles(db: DataDb, showFiles: boolean): boolean {
  return writeFlag(db, SIDEBAR_SHOW_FILES_SETTINGS_KEY, showFiles)
}
