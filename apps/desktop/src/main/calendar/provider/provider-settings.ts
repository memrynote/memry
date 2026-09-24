import type { z } from 'zod'
import {
  CALENDAR_GOOGLE_SETTINGS_DEFAULTS,
  CALENDAR_PROVIDER_BASE_SETTINGS_DEFAULTS,
  CALENDAR_WRITABLE_PROVIDER_SETTINGS_DEFAULTS,
  CalendarGoogleSettingsSchema,
  CalendarProviderBaseSettingsSchema,
  CalendarWritableProviderSettingsSchema,
  calendarProviderSettingsKey,
  type CalendarProviderSettings
} from '@memry/contracts/settings-schemas'
import { GOOGLE_CALENDAR_PROVIDER } from '@memry/contracts/calendar-api'
import type { DataDb } from '../../database'
import { getSetting, setSetting } from '../../settings/settings-store'
import { readCalendarGoogleSettings } from '../google/calendar-google-settings'
import { isKnownProvider, providerCapabilities } from './capabilities'

interface ProviderSettingsShape {
  key: string
  defaults: CalendarProviderSettings
  schema: z.ZodObject
}

/**
 * The settings group a provider owns (#1394). Google keeps `calendar.google`
 * with its exact historical shape; every other known provider gets the shared
 * base, plus the neutral one-way switch when it can write. Unknown providers
 * have no group.
 */
export function calendarProviderSettingsShape(providerId: string): ProviderSettingsShape | null {
  if (!isKnownProvider(providerId)) return null
  const key = calendarProviderSettingsKey(providerId)
  if (providerId === GOOGLE_CALENDAR_PROVIDER) {
    return {
      key,
      defaults: CALENDAR_GOOGLE_SETTINGS_DEFAULTS,
      schema: CalendarGoogleSettingsSchema
    }
  }
  return providerCapabilities(providerId).supportsWrite
    ? {
        key,
        defaults: CALENDAR_WRITABLE_PROVIDER_SETTINGS_DEFAULTS,
        schema: CalendarWritableProviderSettingsSchema
      }
    : {
        key,
        defaults: CALENDAR_PROVIDER_BASE_SETTINGS_DEFAULTS,
        schema: CalendarProviderBaseSettingsSchema
      }
}

/**
 * Keep only the fields the group declares, each validated. Only keys the
 * caller actually sent survive: a schema default must never overwrite a stored
 * answer the update did not mention (an unrelated write would otherwise reset
 * `agentReadEventsConsent` to "not asked").
 */
export function sanitizeCalendarProviderSettingsUpdates(
  providerId: string,
  updates: Record<string, unknown>
): Record<string, unknown> | null {
  const shape = calendarProviderSettingsShape(providerId)
  if (!shape) return null
  const parsed = shape.schema.partial().safeParse(updates)
  if (!parsed.success) return null
  const data = parsed.data as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(updates)
      .filter((field) => field in shape.defaults)
      .map((field) => [field, data[field]])
  )
}

/** Read a provider's group from inside the main process, defaults filled in. */
export function readCalendarProviderSettings(
  db: DataDb,
  providerId: string
): CalendarProviderSettings {
  if (providerId === GOOGLE_CALENDAR_PROVIDER) return readCalendarGoogleSettings(db)
  const shape = calendarProviderSettingsShape(providerId)
  if (!shape) return { ...CALENDAR_PROVIDER_BASE_SETTINGS_DEFAULTS }
  const raw = getSetting(db, shape.key)
  if (!raw) return { ...shape.defaults }
  try {
    return { ...shape.defaults, ...(JSON.parse(raw) as Partial<CalendarProviderSettings>) }
  } catch {
    return { ...shape.defaults }
  }
}

/** Merge validated updates into a provider's group, from inside the main process. */
export function writeCalendarProviderSettings(
  db: DataDb,
  providerId: string,
  updates: Record<string, unknown>
): boolean {
  const shape = calendarProviderSettingsShape(providerId)
  const clean = sanitizeCalendarProviderSettingsUpdates(providerId, updates)
  if (!shape || !clean) return false
  setSetting(
    db,
    shape.key,
    JSON.stringify({ ...readCalendarProviderSettings(db, providerId), ...clean })
  )
  return true
}

/**
 * Whether this provider may push Memry items out. Google keeps reading
 * `pushEventsToGoogle`; every other writable provider reads the neutral
 * `pushEventsToProvider`. A provider without a write path never pushes.
 */
export function isProviderPushEnabled(db: DataDb, providerId: string): boolean {
  if (!providerCapabilities(providerId).supportsWrite) return false
  const settings = readCalendarProviderSettings(db, providerId) as Record<string, unknown>
  if (providerId === GOOGLE_CALENDAR_PROVIDER) return settings.pushEventsToGoogle !== false
  return settings.pushEventsToProvider !== false
}

/** Providers whose events the agent may read: an explicit `true`, nothing else. */
export function listAgentConsentedProviders(db: DataDb, providerIds: string[]): string[] {
  return providerIds.filter(
    (providerId) =>
      (readCalendarProviderSettings(db, providerId) as { agentReadEventsConsent?: unknown })
        .agentReadEventsConsent === true
  )
}
