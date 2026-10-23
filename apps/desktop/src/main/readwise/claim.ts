import { eq } from 'drizzle-orm'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { setSetting } from '../database/queries/settings'
import type { DataDb } from '../database/types'
import { syncSettingsFieldUpdate } from '../settings/runtime-effects'
import { READWISE_SETTINGS_KEY, readReadwiseGroup } from './settings'

/**
 * The claim (#1408 D8): `syncDeviceId` in the synced `readwise` group names the
 * one device that pulls from Readwise. `syncDeviceName` is its label for the
 * other devices' panels. Both are plain leaves of the group, each under its own
 * field clock. Neither is ever removed from the row: a claim is cleared with an
 * explicit `null` (§13.4 of docs/protocol), because an absent key means "this
 * build does not know the value" and a merge keeps the old one.
 */
export interface ReadwiseClaim {
  deviceId: string | null
  deviceName: string | null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function readClaim(db: DataDb): ReadwiseClaim {
  const group = readReadwiseGroup(db)
  return {
    deviceId: stringOrNull(group.syncDeviceId),
    deviceName: stringOrNull(group.syncDeviceName)
  }
}

function writeClaimFields(db: DataDb, claim: ReadwiseClaim): void {
  const next = {
    ...readReadwiseGroup(db),
    syncDeviceId: claim.deviceId,
    syncDeviceName: claim.deviceName
  }
  setSetting(db, READWISE_SETTINGS_KEY, JSON.stringify(next))
  syncSettingsFieldUpdate('readwise.syncDeviceId', claim.deviceId)
  syncSettingsFieldUpdate('readwise.syncDeviceName', claim.deviceName)
}

/** Makes `deviceId` the pulling device. The caller waits for the push. */
export function writeClaim(
  db: DataDb,
  claim: { deviceId: string; deviceName: string | null }
): void {
  writeClaimFields(db, claim)
}

/** Clears the claim with `null`, and sends nothing when there is none. */
export function clearClaim(db: DataDb): void {
  const group = readReadwiseGroup(db)
  if (stringOrNull(group.syncDeviceId) === null && stringOrNull(group.syncDeviceName) === null) {
    return
  }
  writeClaimFields(db, { deviceId: null, deviceName: null })
}

/** This device's label in the account's device list, or null before it registers. */
export function readCurrentDeviceName(db: DataDb): string | null {
  const row = db
    .select({ name: syncDevices.name })
    .from(syncDevices)
    .where(eq(syncDevices.isCurrentDevice, true))
    .get()
  return row?.name ?? null
}
