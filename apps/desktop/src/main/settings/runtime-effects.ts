import { syncSettingsFieldUpdate } from '../sync/local-mutations'

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
