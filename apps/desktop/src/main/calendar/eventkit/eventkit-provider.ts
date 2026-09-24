import {
  APPLE_EVENTKIT_CALENDAR_PROVIDER,
  CALENDAR_PROVIDER_UNSUPPORTED_PLATFORM,
  type CalendarProviderMutationResponse,
  type RetryCalendarSourceSyncResponse
} from '@memry/contracts/calendar-api'
import type { CalendarSource } from '@memry/db-schema/schema/calendar-sources'
import type { DataDb } from '../../database'
import { createLogger } from '../../lib/logger'
import { mapCalendarSource } from '../calendar-source-record'
import { getCalendarSourceById } from '../repositories/calendar-sources-repository'
import { PROVIDER_CAPABILITIES } from '../provider/capabilities'
import type { ProviderDefinition } from '../provider/registry'
import { buildProviderStatus } from '../provider/status'
import { loadEventKitBridge } from './eventkit-loader'
import {
  APPLE_ACCOUNT_ID,
  appleAccountPermission,
  getAppleAccount,
  permissionErrorCode,
  purgeAppleCalendarEvents,
  recordAppleAccountState,
  removeAppleCalendarData
} from './eventkit-mirror'
import { releaseAppleCalendarBridge, requestAppleCalendarPass } from './eventkit-runner'
import { passErrorCode, syncAppleCalendarEvents } from './eventkit-sync'
import type { EventKitAuthorizationStatus } from './eventkit-types'

/**
 * macOS Calendar (#2374): every calendar Calendar.app already has, read
 * through EventKit with no login. Read-only, device-local, macOS only. The
 * registry hides it on Windows and Linux (`platforms: ['darwin']`), so none of
 * this runs there; the bridge itself is only reached through the darwin-gated
 * loader.
 */

const log = createLogger('Calendar:EventKitProvider')

async function response(
  db: DataDb,
  outcome: { ok: true } | { ok: false; errorCode: string }
): Promise<CalendarProviderMutationResponse> {
  const status = await buildProviderStatus(db, APPLE_EVENTKIT_CALENDAR_PROVIDER)
  return outcome.ok
    ? { success: true, status }
    : { success: false, status, errorCode: outcome.errorCode, error: outcome.errorCode }
}

/**
 * Connect is the only place the macOS permission dialog can appear, and only
 * when the user has never answered. Denied, restricted and write-only access
 * save nothing and report why, so the panel can explain the fix.
 */
async function connectApple(db: DataDb): Promise<CalendarProviderMutationResponse> {
  const load = await loadEventKitBridge()
  if (load.status === 'unsupported_platform') {
    return await response(db, { ok: false, errorCode: CALENDAR_PROVIDER_UNSUPPORTED_PLATFORM })
  }
  if (load.status === 'unavailable')
    return await response(db, { ok: false, errorCode: 'unavailable' })

  let permission: EventKitAuthorizationStatus
  try {
    permission = await load.bridge.authorizationStatus()
    if (permission === 'not_determined') permission = await load.bridge.requestFullAccess()
  } catch (error) {
    return await response(db, { ok: false, errorCode: passErrorCode(error) })
  }

  const denied = permissionErrorCode(permission)
  if (denied) {
    // An existing connection learns the new state; a first connect saves nothing.
    recordAppleAccountState(db, { permission, now: new Date().toISOString() })
    return await response(db, { ok: false, errorCode: denied })
  }

  recordAppleAccountState(db, { permission, now: new Date().toISOString(), create: true })
  const outcome = await requestAppleCalendarPass(db)
  if (outcome && !outcome.ok) return await response(db, { ok: false, errorCode: outcome.errorCode })
  log.info('macOS Calendar connected')
  return await response(db, { ok: true })
}

async function refreshApple(db: DataDb): Promise<CalendarProviderMutationResponse> {
  if (!getAppleAccount(db)) return await response(db, { ok: true })
  const outcome = await requestAppleCalendarPass(db)
  if (!outcome) return await response(db, { ok: false, errorCode: 'sync_failed' })
  return await response(db, outcome.ok ? { ok: true } : { ok: false, errorCode: outcome.errorCode })
}

async function syncOneSource(db: DataDb, source: CalendarSource): Promise<string | null> {
  const load = await loadEventKitBridge()
  if (load.status !== 'available') return 'unavailable'
  try {
    await syncAppleCalendarEvents(db, load.bridge, { sourceIds: [source.id] })
    return null
  } catch (error) {
    return passErrorCode(error)
  }
}

function hasReadAccess(db: DataDb): boolean {
  return appleAccountPermission(getAppleAccount(db)) === 'full_access'
}

export const appleEventKitCalendarProvider: ProviderDefinition = {
  id: APPLE_EVENTKIT_CALENDAR_PROVIDER,
  capabilities: PROVIDER_CAPABILITIES[APPLE_EVENTKIT_CALENDAR_PROVIDER],
  connect: (db) => connectApple(db),
  async disconnect(db) {
    await releaseAppleCalendarBridge()
    removeAppleCalendarData(db)
    return await response(db, { ok: true })
  },
  refresh: (db) => refreshApple(db),
  // Answered from the saved permission, so opening Settings never spawns the helper.
  hasAnyLocalAuth: async (db) => hasReadAccess(db),
  hasAccountLocalAuth: async (db, accountId) => accountId === APPLE_ACCOUNT_ID && hasReadAccess(db),
  async accountReconnectReason(db) {
    const permission = appleAccountPermission(getAppleAccount(db))
    return permission === 'denied' || permission === 'restricted' || permission === 'write_only'
      ? 'rejected'
      : 'missing'
  },
  onSelectionChanged(db, before, after) {
    if (!after.isSelected) {
      purgeAppleCalendarEvents(db, [after.id])
      return
    }
    if (!before.isSelected) {
      void syncOneSource(db, after).then((errorCode) => {
        if (errorCode) log.warn('Reading a newly shown macOS calendar failed', { errorCode })
      })
    }
  },
  async retrySource(db, source): Promise<RetryCalendarSourceSyncResponse> {
    const errorCode = await syncOneSource(db, source)
    const updated = getCalendarSourceById(db, source.id)
    return {
      success: errorCode === null,
      source: updated ? mapCalendarSource(updated) : null,
      ...(errorCode ? { error: errorCode } : {})
    }
  }
}
