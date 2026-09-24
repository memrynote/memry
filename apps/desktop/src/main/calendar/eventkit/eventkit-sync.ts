import type { DataDb } from '../../database/types'
import { createLogger } from '../../lib/logger'
import { emitCalendarProjectionChanged } from '../change-events'
import {
  applyEventKitEvents,
  eventKitWindow,
  listAppleCalendarSources,
  purgeAppleCalendarEvents,
  reconcileAppleCalendars,
  recordAppleAccountState,
  recordAppleCalendarRead
} from './eventkit-mirror'
import {
  EventKitBridgeError,
  type EventKitAuthorizationStatus,
  type EventKitBridge
} from './eventkit-types'

const log = createLogger('Calendar:EventKitSync')

export interface AppleSyncDeps {
  now?: () => Date
}

export type AppleSyncOutcome =
  | { ok: true; permission: 'full_access'; changed: number }
  | { ok: false; permission: EventKitAuthorizationStatus | null; errorCode: string }

const HELPER_DOWN = new Set(['helper_unavailable', 'helper_exited', 'disposed', 'timeout'])

/** The code the settings panel localizes for a failed pass. */
export function passErrorCode(error: unknown): string {
  if (!(error instanceof EventKitBridgeError)) return 'sync_failed'
  if (error.code === 'not_authorized') return 'permission_denied'
  return HELPER_DOWN.has(error.code) ? 'unavailable' : 'sync_failed'
}

function nowOf(deps: AppleSyncDeps): Date {
  return deps.now?.() ?? new Date()
}

/**
 * Access went away (denied, restricted, write-only, or revoked in System
 * Settings while the app ran). The mirror is purged locally, never enqueued;
 * the calendar rows and the user's choices stay so a re-grant picks up where
 * it left off.
 */
export function applyApplePermissionLoss(
  db: DataDb,
  permission: EventKitAuthorizationStatus,
  deps: AppleSyncDeps = {}
): void {
  purgeAppleCalendarEvents(db)
  recordAppleAccountState(db, { permission, now: nowOf(deps).toISOString() })
}

/**
 * Read the selected calendars' events over the mirror window and apply them.
 * `sourceIds` limits the read to those calendars; unselected ones lose their
 * events either way.
 */
export async function syncAppleCalendarEvents(
  db: DataDb,
  bridge: EventKitBridge,
  options: AppleSyncDeps & { sourceIds?: string[] } = {}
): Promise<number> {
  const now = nowOf(options)
  const nowIso = now.toISOString()
  const window = eventKitWindow(now)
  const sources = listAppleCalendarSources(db)
  const hidden = sources.filter((row) => !row.isSelected).map((row) => row.id)
  if (hidden.length > 0) purgeAppleCalendarEvents(db, hidden)

  const wanted = sources.filter(
    (row) => row.isSelected && (!options.sourceIds || options.sourceIds.includes(row.id))
  )
  if (wanted.length === 0) return 0

  const events = await bridge.listEvents({
    calendarIds: wanted.map((row) => row.remoteId),
    start: window.startAt,
    end: window.endAt
  })
  const byCalendar = new Map<string, typeof events>()
  for (const event of events) {
    const bucket = byCalendar.get(event.calendarId) ?? []
    bucket.push(event)
    byCalendar.set(event.calendarId, bucket)
  }

  let changed = 0
  for (const row of wanted) {
    changed += applyEventKitEvents(db, row.id, byCalendar.get(row.remoteId) ?? [], window, nowIso)
    recordAppleCalendarRead(db, row.id, { ok: true, at: nowIso })
  }
  if (changed > 0) emitCalendarProjectionChanged('apple-eventkit:sync')
  return changed
}

/**
 * One full pass: check the permission, reconcile the calendar list, re-read
 * the window. Local and cheap, so every change notification runs one.
 */
export async function runAppleCalendarPass(
  db: DataDb,
  bridge: EventKitBridge,
  deps: AppleSyncDeps = {}
): Promise<AppleSyncOutcome> {
  let permission: EventKitAuthorizationStatus | null = null
  try {
    permission = await bridge.authorizationStatus()
    if (permission !== 'full_access') {
      applyApplePermissionLoss(db, permission, deps)
      return { ok: false, permission, errorCode: `permission_${permission}` }
    }
    const calendars = await bridge.listCalendars()
    reconcileAppleCalendars(db, calendars, { now: nowOf(deps).toISOString() })
    const changed = await syncAppleCalendarEvents(db, bridge, deps)
    const nowIso = nowOf(deps).toISOString()
    recordAppleAccountState(db, { permission, syncedAt: nowIso, now: nowIso })
    return { ok: true, permission, changed }
  } catch (error) {
    const errorCode = passErrorCode(error)
    log.warn('macOS Calendar pass failed', {
      code: error instanceof EventKitBridgeError ? error.code : 'unknown'
    })
    recordAppleAccountState(db, {
      ...(permission ? { permission } : {}),
      error: errorCode,
      now: nowOf(deps).toISOString()
    })
    return { ok: false, permission, errorCode }
  }
}
