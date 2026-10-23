import {
  READWISE_CADENCES,
  READWISE_CATEGORIES,
  READWISE_FOLDER_LAYOUTS,
  READWISE_OPTIONS_DEFAULTS,
  type ReadwiseOptions,
  type ReadwiseSetOptionsInput
} from '@memry/contracts/import-channels'
import { getDatabase } from '../database'
import { getSetting, setSetting } from '../database/queries/settings'
import type { DataDb } from '../database/types'
import { setFullPassPending } from './sync-state'
import { createLogger } from '../lib/logger'
import { syncSettingsFieldUpdate } from '../settings/runtime-effects'

const log = createLogger('ReadwiseSettings')

/**
 * The `readwise` synced settings group (#1408 D8): one JSON row in the data DB,
 * one field clock per leaf (`readwise.categories.supplementals`, ...). The row
 * holds only the values the user set, so a stored default never records a
 * decision that could overwrite another device's real choice. Fields a newer
 * build adds (`syncDeviceId`, ...) stay in the row untouched. The token and the
 * run state (cursor, retry list) are not here.
 */
export const READWISE_SETTINGS_KEY = 'readwise'

export function readReadwiseGroup(db: DataDb): Record<string, unknown> {
  const raw = getSetting(db, READWISE_SETTINGS_KEY)
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch (err) {
    // The row only holds the user's choices; defaults take over until the user
    // sets them again or another device's value merges in.
    log.warn('Unreadable Readwise settings, using defaults', err)
    return {}
  }
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

/** Stored values over the defaults. A value only a newer build knows reads as the default. */
export function readReadwiseOptions(db: DataDb): ReadwiseOptions {
  const stored = readReadwiseGroup(db)
  const defaults = READWISE_OPTIONS_DEFAULTS
  const storedCategories =
    typeof stored.categories === 'object' && stored.categories !== null
      ? (stored.categories as Record<string, unknown>)
      : {}

  const categories = { ...defaults.categories }
  for (const category of READWISE_CATEGORIES) {
    const value = storedCategories[category]
    if (typeof value === 'boolean') categories[category] = value
  }

  const rootFolder =
    typeof stored.rootFolder === 'string' && stored.rootFolder.trim()
      ? stored.rootFolder
      : defaults.rootFolder

  return {
    rootFolder,
    folderLayout: oneOf(READWISE_FOLDER_LAYOUTS, stored.folderLayout, defaults.folderLayout),
    categories,
    cadence: oneOf(READWISE_CADENCES, stored.cadence, defaults.cadence),
    readerDocuments:
      typeof stored.readerDocuments === 'boolean'
        ? stored.readerDocuments
        : defaults.readerDocuments,
    readerFullText:
      typeof stored.readerFullText === 'boolean' ? stored.readerFullText : defaults.readerFullText
  }
}

/**
 * A category that goes from off to on needs its books read once, and the
 * export has no category filter, so the next run reads all of it (D7). The
 * saved-documents switch does too: the v2 books tell the Reader pass which
 * documents already have a note (D11). The flag is device-local run state.
 */
function flagCategoriesSwitchedOn(db: DataDb, before: ReadwiseOptions): void {
  const after = readReadwiseOptions(db)
  if (
    (after.readerDocuments && !before.readerDocuments) ||
    READWISE_CATEGORIES.some(
      (category) => after.categories[category] && !before.categories[category]
    )
  ) {
    setFullPassPending(db, true)
  }
}

/** Writes the changed fields, each under its own field clock. */
export function writeReadwiseOptions(db: DataDb, updates: ReadwiseSetOptionsInput): void {
  const stored = readReadwiseGroup(db)
  const next: Record<string, unknown> = { ...stored }
  const pushes: [string, unknown][] = []

  if (updates.rootFolder !== undefined) {
    next.rootFolder = updates.rootFolder
    pushes.push(['readwise.rootFolder', updates.rootFolder])
  }
  if (updates.folderLayout !== undefined) {
    next.folderLayout = updates.folderLayout
    pushes.push(['readwise.folderLayout', updates.folderLayout])
  }
  if (updates.cadence !== undefined) {
    next.cadence = updates.cadence
    pushes.push(['readwise.cadence', updates.cadence])
  }
  if (updates.readerDocuments !== undefined) {
    next.readerDocuments = updates.readerDocuments
    pushes.push(['readwise.readerDocuments', updates.readerDocuments])
  }
  if (updates.readerFullText !== undefined) {
    next.readerFullText = updates.readerFullText
    pushes.push(['readwise.readerFullText', updates.readerFullText])
  }
  if (updates.categories) {
    const categories: Record<string, unknown> =
      typeof stored.categories === 'object' && stored.categories !== null
        ? { ...(stored.categories as Record<string, unknown>) }
        : {}
    for (const [category, enabled] of Object.entries(updates.categories)) {
      if (enabled === undefined) continue
      categories[category] = enabled
      pushes.push([`readwise.categories.${category}`, enabled])
    }
    next.categories = categories
  }

  if (pushes.length === 0) return
  const before = readReadwiseOptions(db)
  setSetting(db, READWISE_SETTINGS_KEY, JSON.stringify(next))
  flagCategoriesSwitchedOn(db, before)
  for (const [path, value] of pushes) syncSettingsFieldUpdate(path, value)
}

/**
 * Merges the `readwise` group a remote device won into the stored row. A raw
 * write, so it does not echo back into settings sync. Absent leaves keep the
 * local value, and fields this build does not model ride along.
 */
export function applyMergedReadwiseSettings(db: DataDb, merged: Record<string, unknown>): void {
  const stored = readReadwiseGroup(db)
  const { categories: mergedCategories, ...rest } = merged
  const next: Record<string, unknown> = { ...stored, ...rest }
  if (typeof mergedCategories === 'object' && mergedCategories !== null) {
    const current =
      typeof stored.categories === 'object' && stored.categories !== null ? stored.categories : {}
    next.categories = { ...current, ...mergedCategories }
  }
  const before = readReadwiseOptions(db)
  setSetting(db, READWISE_SETTINGS_KEY, JSON.stringify(next))
  flagCategoriesSwitchedOn(db, before)
}

/**
 * The root folder setting follows an in-app rename or move of that folder, or
 * of a folder above it, as shortcuts do (D3). Existing notes move with the
 * folder, so only the setting changes. No open vault, nothing to follow.
 */
export function followFolderRenameInReadwise(oldPath: string, newPath: string): void {
  let db: DataDb
  try {
    db = getDatabase()
  } catch {
    return
  }
  const { rootFolder } = readReadwiseOptions(db)
  if (rootFolder !== oldPath && !rootFolder.startsWith(`${oldPath}/`)) return
  writeReadwiseOptions(db, { rootFolder: newPath + rootFolder.slice(oldPath.length) })
}
