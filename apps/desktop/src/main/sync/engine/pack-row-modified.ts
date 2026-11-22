import { getCurrentDeviceId } from '@memry/sync-client/current-device-id'
import type { SyncItemType } from '@memry/contracts/sync-api'

import { createLogger } from '../../lib/logger'
import { getHandler, type DrizzleDb } from '../item-handlers'
import { hasPendingWrite } from './purged-tombstone-guard'

const log = createLogger('PackRowModified')

const clockOf = (row: Record<string, unknown>): Record<string, unknown> | null => {
  const value = row.clock ?? row.vectorClock
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an object checked right here; entries are only probed by key
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an object checked right here; entries are only probed by key
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/**
 * Whether §8.10 rule 2 pulls an unlisted pack-phase row by id (#5390): its
 * local row exists and this device did not modify it since. A queued write,
 * its own device in the clock (only a local edit puts it there on a fresh
 * device), or no clock to tell keeps the row out of the pull. The pull, not
 * this check, decides a delete: only a verified delete or an attested marker
 * removes the row (protocol 05 §5.12.1).
 */
export function pullsUnlistedRow(db: DrizzleDb, key: string): boolean {
  const split = key.indexOf(':')
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- keys are written from validated pull items' types
  const type = key.slice(0, split) as SyncItemType
  const itemId = key.slice(split + 1)
  const local = getHandler(type)?.fetchLocal?.(db, itemId)
  if (!local) return false
  const clock = clockOf(local)
  const deviceId = getCurrentDeviceId(db)
  if (
    !clock ||
    Object.keys(clock).length === 0 ||
    (deviceId !== null && deviceId in clock) ||
    hasPendingWrite(db, type, itemId)
  ) {
    log.info('Unlisted pack-phase row kept: modified here', { type, itemId })
    return false
  }
  return true
}

/**
 * Whether this device's own id is in the local row's clock (#5390): it edited
 * the row, so the manifest check re-uploads it even while rule 2 holds it
 * unresolved. No row, no clock or no device id reads as not edited here.
 */
export function editedHere(db: DrizzleDb, type: SyncItemType, itemId: string): boolean {
  const local = getHandler(type)?.fetchLocal?.(db, itemId)
  const clock = local ? clockOf(local) : null
  const deviceId = getCurrentDeviceId(db)
  return clock !== null && deviceId !== null && deviceId in clock
}
