/**
 * Process-wide holder for the active vault's journal configuration.
 *
 * Journal detection helpers (`isJournalEntry`, `extractDateFromPath`,
 * `generateJournalPath`) are pure path utilities called from many places that do
 * not have the vault config in scope. Rather than thread the config through every
 * call site, the single `getConfig()` accessor keeps this holder in sync, mirroring
 * the existing module-level vault state pattern.
 */

import { normalizeJournalDateFormat, normalizeJournalFolder } from '@memry/storage-vault'

export interface JournalConfig {
  journalFolder: string
  journalDateFormat: string
}

let current: JournalConfig = {
  journalFolder: 'journal',
  journalDateFormat: 'YYYY-MM-DD'
}

export function setJournalConfig(config: JournalConfig): void {
  current = config
}

export function getJournalConfig(): JournalConfig {
  return current
}

/**
 * Push journal settings into the holder, but only when they differ.
 *
 * The vault's getConfig() runs on most vault operations and many callers depend
 * on it keeping the holder fresh, so the side effect stays — writing an
 * identical value on every call is the part that was pure overhead.
 */
export function syncJournalConfig(config: JournalConfig): void {
  if (
    current.journalFolder === config.journalFolder &&
    current.journalDateFormat === config.journalDateFormat
  ) {
    return
  }
  current = {
    journalFolder: config.journalFolder,
    journalDateFormat: config.journalDateFormat
  }
}

/**
 * `journalFolder` and `journalDateFormat` in canonical form, wherever they are
 * strings: `/Daily Notes/` and `Daily Notes` name one folder, `YYYY//MM` is
 * `YYYY/MM`. Applied to config on read as well as on write, so a hand-edited or
 * older config.json matches vault paths too. Anything else passes through.
 */
export function normalizeJournalSettings<T extends Partial<JournalConfig>>(config: T): T {
  const normalized = { ...config }
  if (typeof config.journalFolder === 'string') {
    normalized.journalFolder = normalizeJournalFolder(config.journalFolder)
  }
  if (typeof config.journalDateFormat === 'string') {
    normalized.journalDateFormat = normalizeJournalDateFormat(config.journalDateFormat)
  }
  return normalized
}
