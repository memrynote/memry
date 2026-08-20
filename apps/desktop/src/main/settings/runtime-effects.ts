import { syncSettingsFieldUpdate } from '../sync/local-mutations'

// Re-exported so IPC handlers reach the sync layer through this one seam
// rather than importing sync/local-mutations directly.
export { syncSettingsFieldUpdate }

export function syncSettingsUpdates<T extends Record<string, unknown>>(
  groupKey: string,
  updates: Partial<T>,
  syncableFields: readonly (keyof T)[]
): void {
  for (const field of syncableFields) {
    const value = updates[field]
    if (value !== undefined) {
      syncSettingsFieldUpdate(`${groupKey}.${String(field)}`, value)
    }
  }
}

/**
 * Enqueue one sync field update per entry of a map-valued setting.
 *
 * `syncSettingsUpdates` gives the whole map a single field clock, which makes
 * two devices editing different entries concurrently resolve as one map
 * overwriting the other — the loser's entry disappears with no conflict to see.
 * Addressing each entry as its own dotted field path (`journal.weekdayTemplates.3`)
 * gives it its own clock, so those two edits merge instead.
 */
export function syncSettingsMapEntryUpdates(
  groupKey: string,
  field: string,
  entries: Record<string, unknown>,
  isValidEntryKey: (key: string) => boolean
): void {
  for (const [entryKey, value] of Object.entries(entries)) {
    if (!isValidEntryKey(entryKey)) continue
    syncSettingsFieldUpdate(`${groupKey}.${field}.${entryKey}`, value)
  }
}
