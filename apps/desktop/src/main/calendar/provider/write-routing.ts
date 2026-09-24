import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { GOOGLE_CALENDAR_PROVIDER } from '@memry/contracts/calendar-api'
import { calendarBindings, type CalendarBinding } from '@memry/db-schema/schema/calendar-bindings'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { calendarSources, type CalendarSource } from '@memry/db-schema/schema/calendar-sources'
import type { DataDb } from '../../database'
import { deleteSetting, getSetting, setSetting } from '../../settings/settings-store'
import { readCalendarGoogleSettings } from '../google/calendar-google-settings'
import type { CalendarSyncTarget } from '../types'

/**
 * Write routing (#2372): exactly one provider writes each Memry item.
 *
 * Trace of what this prevents. Device A has Google and CalDAV, with CalDAV's
 * "Work" as the default target, so a task gets a `caldav` binding. Device B
 * has Google with pushing on. It receives the task and the binding, the user
 * edits the title, and without routing B's Google push finds no Google
 * binding and creates the task in Google too. From then on every edit forks.
 *
 * The rule: a live binding of any provider decides; otherwise the event's
 * `target_calendar_id`, looked up across providers; otherwise the default
 * write target. Only the resolved provider may push the item.
 */

export const DEFAULT_WRITE_TARGET_SETTINGS_KEY = 'calendar.defaultWriteTarget'

export const DefaultWriteTargetSchema = z
  .object({
    provider: z.string().min(1),
    remoteCalendarId: z.string().min(1)
  })
  .nullable()

export type DefaultWriteTarget = z.infer<typeof DefaultWriteTargetSchema>

export interface WriteRoute {
  /** The one provider allowed to write this item. */
  provider: string
  /** The remote calendar the provider should write to, when routing decided one. */
  remoteCalendarId: string | null
  /** The live binding that decided the route, if any. */
  binding: CalendarBinding | null
  reason: 'binding' | 'event_target' | 'default_target' | 'legacy_google'
}

/**
 * The item's live binding, whatever its provider. Before any provider
 * creates a remote event it asks this; one that belongs to someone else means
 * "not yours". Should two exist (an older build double-pushed), the oldest
 * wins, so every device picks the same one.
 */
export function findLiveBinding(db: DataDb, target: CalendarSyncTarget): CalendarBinding | null {
  const rows = db
    .select()
    .from(calendarBindings)
    .where(
      and(
        eq(calendarBindings.sourceType, target.sourceType),
        eq(calendarBindings.sourceId, target.sourceId),
        isNull(calendarBindings.archivedAt)
      )
    )
    .all()
  if (rows.length === 0) return null
  return [...rows].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  )[0]
}

/**
 * The calendar source a bare remote calendar id refers to, across providers.
 * `target_calendar_id` keeps its old format because older builds read it as a
 * Google calendar id. CalDAV ids are collection URLs and Graph ids are opaque,
 * so a collision is not expected; if one happens, Google wins and existing
 * installs behave as they always did.
 */
export function findCalendarByRemoteId(
  db: DataDb,
  remoteCalendarId: string
): CalendarSource | null {
  const rows = db
    .select()
    .from(calendarSources)
    .where(
      and(
        eq(calendarSources.kind, 'calendar'),
        eq(calendarSources.remoteId, remoteCalendarId),
        isNull(calendarSources.archivedAt)
      )
    )
    .all()
  if (rows.length === 0) return null
  return rows.find((row) => row.provider === GOOGLE_CALENDAR_PROVIDER) ?? rows[0]
}

function readStoredDefaultWriteTarget(db: DataDb): DefaultWriteTarget | undefined {
  const raw = getSetting(db, DEFAULT_WRITE_TARGET_SETTINGS_KEY)
  if (!raw) return undefined
  try {
    const parsed = DefaultWriteTargetSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/**
 * Where tasks, reminders, inbox snoozes and untargeted events go. The new
 * `calendar.defaultWriteTarget` group wins; while it is unset, the chain falls
 * back to `calendar.google.defaultTargetCalendarId`, so an install that only
 * ever had Google settings routes exactly as before.
 */
export function readDefaultWriteTarget(db: DataDb): DefaultWriteTarget {
  const stored = readStoredDefaultWriteTarget(db)
  if (stored !== undefined) return stored
  const { defaultTargetCalendarId } = readCalendarGoogleSettings(db)
  return defaultTargetCalendarId
    ? { provider: GOOGLE_CALENDAR_PROVIDER, remoteCalendarId: defaultTargetCalendarId }
    : null
}

export function writeDefaultWriteTarget(db: DataDb, target: DefaultWriteTarget): void {
  setSetting(
    db,
    DEFAULT_WRITE_TARGET_SETTINGS_KEY,
    JSON.stringify(DefaultWriteTargetSchema.parse(target))
  )
}

/** Clear the cross-provider default when it points at this provider. */
export function clearDefaultWriteTargetFor(db: DataDb, providerId: string): void {
  if (readStoredDefaultWriteTarget(db)?.provider === providerId) {
    deleteSetting(db, DEFAULT_WRITE_TARGET_SETTINGS_KEY)
  }
}

/**
 * Google's own default picker still writes `calendar.google`. Once the
 * cross-provider target exists it would shadow that choice, so a Google
 * default chosen afterwards moves the cross-provider target to Google too.
 * An install that never set a cross-provider target gets no new key.
 */
export function syncDefaultWriteTargetWithGoogle(db: DataDb, calendarId: string | null): void {
  if (readStoredDefaultWriteTarget(db) === undefined) return
  if (calendarId) {
    writeDefaultWriteTarget(db, {
      provider: GOOGLE_CALENDAR_PROVIDER,
      remoteCalendarId: calendarId
    })
  } else {
    deleteSetting(db, DEFAULT_WRITE_TARGET_SETTINGS_KEY)
  }
}

function eventTargetCalendarId(db: DataDb, target: CalendarSyncTarget): string | null {
  if (target.sourceType !== 'event') return null
  const row = db
    .select({ targetCalendarId: calendarEvents.targetCalendarId })
    .from(calendarEvents)
    .where(eq(calendarEvents.id, target.sourceId))
    .get()
  return row?.targetCalendarId ?? null
}

/** The one provider that writes this item, and where. */
export function resolveWriteRoute(db: DataDb, target: CalendarSyncTarget): WriteRoute {
  const binding = findLiveBinding(db, target)
  if (binding) {
    return {
      provider: binding.provider,
      remoteCalendarId: binding.remoteCalendarId,
      binding,
      reason: 'binding'
    }
  }

  const eventTarget = eventTargetCalendarId(db, target)
  if (eventTarget) {
    const source = findCalendarByRemoteId(db, eventTarget)
    // An id no source knows is what older builds always sent Google: the
    // picker offered only Google calendars, so it stays Google's.
    return {
      provider: source?.provider ?? GOOGLE_CALENDAR_PROVIDER,
      remoteCalendarId: eventTarget,
      binding: null,
      reason: 'event_target'
    }
  }

  const defaultTarget = readDefaultWriteTarget(db)
  if (defaultTarget) {
    return {
      provider: defaultTarget.provider,
      remoteCalendarId: defaultTarget.remoteCalendarId,
      binding: null,
      reason: 'default_target'
    }
  }

  // Nothing chosen anywhere: Google's own fallback (its managed memrynote
  // calendar), exactly as before any other writer existed.
  return {
    provider: GOOGLE_CALENDAR_PROVIDER,
    remoteCalendarId: null,
    binding: null,
    reason: 'legacy_google'
  }
}
