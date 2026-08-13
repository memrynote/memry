import {
  CALENDAR_GOOGLE_SETTINGS_DEFAULTS,
  CALENDAR_PROVIDER_SETTINGS_DEFAULTS,
  type CalendarGoogleSettings,
  type CalendarProviderSettings
} from '@memry/contracts/settings-schemas'
import { getSetting, setSetting } from '../../settings/settings-store'
import type { DataDb } from '../../database/types'

export const GOOGLE_LEGACY_SETTINGS_PROVIDER_ID = 'google'

export function calendarProviderSettingsKey(providerId: string): string {
  return `calendar.${providerId}`
}

function readGroup<T>(db: DataDb, key: string, defaults: T): T {
  const raw = getSetting(db, key)
  if (!raw) return { ...defaults }
  try {
    const parsed = JSON.parse(raw) as Partial<T>
    return { ...defaults, ...parsed }
  } catch {
    return { ...defaults }
  }
}

/**
 * Read one provider's settings in the neutral shape.
 *
 * Google is the one exception, and it is a naming exception only: its group was
 * written before there was a second provider, so its outbound toggle is stored
 * as `pushEventsToGoogle`. The row is read and written in that exact shape —
 * no migration, no extra keys — and translated here so callers only ever see
 * `pushEventsToProvider`.
 */
export function readCalendarProviderSettings(
  db: DataDb,
  providerId: string
): CalendarProviderSettings {
  if (providerId === GOOGLE_LEGACY_SETTINGS_PROVIDER_ID) {
    const google = readGroup(
      db,
      calendarProviderSettingsKey(providerId),
      CALENDAR_GOOGLE_SETTINGS_DEFAULTS
    )
    return {
      defaultTargetCalendarId: google.defaultTargetCalendarId,
      onboardingCompleted: google.onboardingCompleted,
      promoteConfirmDismissed: google.promoteConfirmDismissed,
      pushEventsToProvider: google.pushEventsToGoogle,
      agentReadEventsConsent: google.agentReadEventsConsent
    }
  }

  return readGroup(db, calendarProviderSettingsKey(providerId), CALENDAR_PROVIDER_SETTINGS_DEFAULTS)
}

/** Merge a partial update into one provider's group, from inside the main process. */
export function writeCalendarProviderSettings(
  db: DataDb,
  providerId: string,
  updates: Partial<CalendarProviderSettings>
): void {
  const key = calendarProviderSettingsKey(providerId)

  if (providerId === GOOGLE_LEGACY_SETTINGS_PROVIDER_ID) {
    const current = readGroup(db, key, CALENDAR_GOOGLE_SETTINGS_DEFAULTS)
    const { pushEventsToProvider, ...neutral } = updates
    const next: CalendarGoogleSettings = {
      ...current,
      ...neutral,
      ...(pushEventsToProvider === undefined ? {} : { pushEventsToGoogle: pushEventsToProvider })
    }
    setSetting(db, key, JSON.stringify(next))
    return
  }

  const current = readGroup(db, key, CALENDAR_PROVIDER_SETTINGS_DEFAULTS)
  setSetting(db, key, JSON.stringify({ ...current, ...updates }))
}

/**
 * Whether the AI agent may read this provider's external events.
 *
 * The rule is provider-neutral: nothing other than a stored `true` opens the
 * gate. `null` — never asked — reads as no, exactly like an explicit refusal.
 * Google Workspace Limited Use is what forced the question first; the answer
 * became the house rule for every provider.
 */
export function hasAgentReadConsent(db: DataDb, providerId: string): boolean {
  return readCalendarProviderSettings(db, providerId).agentReadEventsConsent === true
}
