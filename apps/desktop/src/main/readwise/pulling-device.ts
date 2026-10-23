import { eq } from 'drizzle-orm'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { getCurrentDeviceId } from '@memry/sync-client/current-device-id'
import { getSetting } from '../database/queries/settings'
import type { DataDb } from '../database/types'
import { getMainI18n } from '../lib/main-i18n'
import { READWISE_SETTINGS_KEY } from './settings'

/**
 * Which device pulls from Readwise (#1408 D8). `syncDeviceId` in the synced
 * `readwise` group names it. With no claim (free plan, a single device, or
 * before #1417 writes one) the device pulls. The book commands (D16) need the
 * token, which lives on the pulling device only, so each asks this first.
 */
function claimedDeviceId(db: DataDb): string | null {
  const raw = getSetting(db, READWISE_SETTINGS_KEY)
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    const id = (parsed as { syncDeviceId?: unknown } | null)?.syncDeviceId
    return typeof id === 'string' && id.length > 0 ? id : null
  } catch {
    // Unreadable settings hold no claim, as `readReadwiseOptions` treats them.
    return null
  }
}

export function thisDevicePulls(db: DataDb): boolean {
  const claimed = claimedDeviceId(db)
  return claimed === null || claimed === getCurrentDeviceId(db)
}

/** The pulling device's name when this device knows it, else null. */
export function pullingDeviceName(db: DataDb): string | null {
  const claimed = claimedDeviceId(db)
  if (claimed === null) return null
  const row = db
    .select({ name: syncDevices.name })
    .from(syncDevices)
    .where(eq(syncDevices.id, claimed))
    .get()
  return row?.name ?? null
}

export function assertThisDevicePulls(db: DataDb): void {
  if (!thisDevicePulls(db)) {
    throw new Error(getMainI18n().t('errors:importer.readwiseSyncsElsewhere'))
  }
}
