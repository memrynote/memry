import type { SyncItemType, VectorClock } from '@memry/contracts/sync-api'
import { incrementClock } from '@memry/sync-core'
import { createLogger } from './logging'

const log = createLogger('DeleteFallback')

type Row = Record<string, unknown>

/**
 * The payload of a delete raised with no caller snapshot (#2423): `body` with
 * the local row's own clock, ticked. Null, so nothing is pushed, when the row
 * is gone or was never clocked. A clock minted from `{}` is `{device: 1}`,
 * which any clock the server holds for the id dominates: the server refuses it
 * as a replay, and without a snapshot this device records no pending delete or
 * tombstone clock for it either.
 */
export function deleteFromLocalRow(
  type: SyncItemType,
  itemId: string,
  local: Row | undefined,
  deviceId: string,
  body: (row: Row) => Row = (row) => row
): string | null {
  const clock = local?.clock as VectorClock | null | undefined
  if (!local || !clock || Object.keys(clock).length === 0) {
    log.warn('Delete not pushed: no snapshot and no clocked local row', { type, itemId })
    return null
  }
  return JSON.stringify({ ...body(local), clock: incrementClock(clock, deviceId) })
}
