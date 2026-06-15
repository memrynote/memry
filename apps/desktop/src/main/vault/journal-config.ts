/**
 * Process-wide holder for the active vault's journal configuration.
 *
 * Journal detection helpers (`isJournalEntry`, `extractDateFromPath`,
 * `generateJournalPath`) are pure path utilities called from many places that do
 * not have the vault config in scope. Rather than thread the config through every
 * call site, the single `getConfig()` accessor keeps this holder in sync, mirroring
 * the existing module-level vault state pattern.
 */

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
