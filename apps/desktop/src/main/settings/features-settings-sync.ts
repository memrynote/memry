import {
  FEATURES_SETTINGS_DEFAULTS,
  type FeaturesSettings
} from '@memry/contracts/settings-schemas'
import type { SettingsSyncManager } from '@memry/sync-client/settings-sync'
import { getSetting } from '../database/queries/settings'
import type { DataDb } from '../database/types'
import { createLogger } from '../lib/logger'

const log = createLogger('FeaturesSettingsSync')

/** Every flag in the `features` group follows the user across devices. */
export const FEATURES_SYNCABLE_FIELDS = Object.keys(
  FEATURES_SETTINGS_DEFAULTS
) as (keyof FeaturesSettings)[]

/**
 * Seed once: a flag this device stored locally but no device has synced yet is
 * pushed from the local value, so an existing install's choices reach its other
 * devices. A flag some device already synced is left to the merge.
 *
 * Only values that differ from the default are pushed. `writeGroupSettings`
 * stores the whole group on every write, so a stored default records no
 * decision, and pushing it would overwrite another device's real choice.
 */
export function seedFeaturesSyncedSettings(
  db: DataDb,
  target: Pick<SettingsSyncManager, 'updateField' | 'getPayload'>
): number {
  const raw = getSetting(db, 'features')
  if (raw === null) return 0

  let stored: Record<string, unknown>
  try {
    stored = JSON.parse(raw) as Record<string, unknown>
  } catch {
    log.warn('Features settings unreadable; skipping seed')
    return 0
  }

  const { settings, fieldClocks } = target.getPayload()
  let seeded = 0
  for (const field of FEATURES_SYNCABLE_FIELDS) {
    const value = stored[field]
    if (typeof value !== 'boolean' || value === FEATURES_SETTINGS_DEFAULTS[field]) continue
    const path = `features.${field}`
    if (Object.prototype.hasOwnProperty.call(fieldClocks, path)) continue
    if (settings.features?.[field] !== undefined) continue
    target.updateField(path, value)
    seeded += 1
  }
  if (seeded > 0) log.info('Seeded features settings into settings sync', { seeded })
  return seeded
}
