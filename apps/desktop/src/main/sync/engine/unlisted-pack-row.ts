import { getCurrentDeviceId } from '@memry/sync-client/current-device-id'
import type { SyncItemType } from '@memry/contracts/sync-api'

import { createLogger } from '../../lib/logger'
import type { ItemApplier } from '../apply-item'
import { getHandler, type DrizzleDb } from '../item-handlers'
import { hasPendingWrite } from './purged-tombstone-guard'

const log = createLogger('UnlistedPackRow')

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
 * §8.10 rule 2: removes a pack-applied row the complete manifest omits, here
 * only, with no push and no tombstone: the delete happened on the server. A
 * row this device modified since is kept: a queued write, its own device in
 * the clock (only a local edit puts it there on a fresh device), or no clock
 * to tell. The delete goes through the pull's apply with no clock, which every
 * handler applies unconditionally and records no tombstone clock for.
 * True when no live local row is left.
 */
export function removeUnlistedPackRow(db: DrizzleDb, applier: ItemApplier, key: string): boolean {
  const split = key.indexOf(':')
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- keys are written from validated pull items' types
  const type = key.slice(0, split) as SyncItemType
  const itemId = key.slice(split + 1)
  const local = getHandler(type)?.fetchLocal?.(db, itemId)
  if (!local) return true
  const clock = clockOf(local)
  const deviceId = getCurrentDeviceId(db)
  if (
    !clock ||
    Object.keys(clock).length === 0 ||
    (deviceId !== null && deviceId in clock) ||
    hasPendingWrite(db, type, itemId)
  ) {
    log.info('Pack-applied row absent from the manifest kept: modified here', { type, itemId })
    return false
  }
  const result = applier.apply({ itemId, type, operation: 'delete', content: new Uint8Array() })
  log.info('Pack-applied row absent from the manifest removed (§8.10 rule 2)', {
    type,
    itemId,
    result
  })
  return result === 'applied'
}
