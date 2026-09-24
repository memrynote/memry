import type { CalendarBinding } from '@memry/db-schema/schema/calendar-bindings'
import type { DataDb } from '../../database'
import type { CalendarSyncTarget } from '../types'
import { providerCapabilities } from './capabilities'
import { getProvider } from './registry'
import { resolveWriteRoute } from './write-routing'

/**
 * Push one local change to exactly one provider (#2372). The route picks the
 * provider; only that provider's writer runs, so an item another provider
 * holds is never created a second time elsewhere. The capability gate lives
 * here, in the engine: a provider without `supportsWrite` never reaches a
 * push call, whatever its definition carries.
 */
export async function syncLocalSourceToProvider(
  db: DataDb,
  target: CalendarSyncTarget
): Promise<CalendarBinding | null> {
  const route = resolveWriteRoute(db, target)
  if (!providerCapabilities(route.provider).supportsWrite) return null
  const writer = getProvider(route.provider)?.writer
  if (!writer) return null
  return await writer.syncLocalSource(db, target, route)
}
