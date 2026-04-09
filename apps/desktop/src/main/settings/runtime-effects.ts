import { getSettingsSyncManager } from '../sync/settings-sync'

export function syncSettingsUpdates<T extends Record<string, unknown>>(
  groupKey: string,
  updates: Partial<T>,
  syncableFields: readonly (keyof T)[]
): void {
  const manager = getSettingsSyncManager()
  if (!manager) return

  for (const field of syncableFields) {
    const value = updates[field]
    if (value !== undefined) {
      manager.updateField(`${groupKey}.${String(field)}`, value, 'local')
    }
  }
}
