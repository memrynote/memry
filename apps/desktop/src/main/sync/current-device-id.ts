import { eq } from 'drizzle-orm'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import type { DataDb } from '../database'

/**
 * The registered id for this device, or `null` before device registration and
 * whenever the user is signed out.
 *
 * A synchronous single-index SELECT — cheap enough to call on a write path.
 *
 * This module exists so there is exactly one copy: the same three-line query
 * had been pasted into `sync/runtime.ts`, `sync/offline-clock.ts` and
 * `calendar/google/sync-service.ts`. It deliberately sits outside
 * `blockedFeatureSyncImports` (see scripts/check-architecture-boundaries.js) so
 * feature modules can import it without reaching into a sync service.
 */
export function getCurrentDeviceId(db: DataDb): string | null {
  const device = db
    .select({ id: syncDevices.id })
    .from(syncDevices)
    .where(eq(syncDevices.isCurrentDevice, true))
    .get()
  return device?.id ?? null
}
