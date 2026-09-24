import {
  GOOGLE_CALENDAR_PROVIDER,
  ICS_CALENDAR_PROVIDER,
  type CalendarProviderCapabilities
} from '@memry/contracts/calendar-api'

/**
 * Declared capabilities per provider (#1391). Each entry reproduces what the
 * provider already does; the table names the behaviour, it does not change it.
 */
export const PROVIDER_CAPABILITIES: Readonly<Record<string, CalendarProviderCapabilities>> = {
  [GOOGLE_CALENDAR_PROVIDER]: {
    supportsWrite: true,
    supportsCreateCalendar: true,
    supportsPush: true,
    supportsMultiAccount: true,
    // Google sync is gated on isMemryUserSignedIn(): the push relay and token
    // refresh go through the Memry account.
    requiresMemryAccount: true,
    mirrorScope: 'synced',
    sourceScope: 'synced',
    incrementalMode: 'sync-token',
    authFlow: 'oauth2'
  },
  [ICS_CALENDAR_PROVIDER]: {
    supportsWrite: false,
    supportsCreateCalendar: false,
    supportsPush: false,
    supportsMultiAccount: false,
    requiresMemryAccount: false,
    // Every device reads the feed itself; validators live in memory, so the
    // mirror stays on the device (#2355).
    mirrorScope: 'device',
    sourceScope: 'synced',
    incrementalMode: 'conditional-get',
    authFlow: 'url'
  }
}

/**
 * What an unknown provider id gets: nothing writable, nothing synced from this
 * device. A row written by a newer build for a provider this build does not
 * know must never be pushed to, promoted, or re-enqueued.
 */
export const UNKNOWN_PROVIDER_CAPABILITIES: CalendarProviderCapabilities = {
  supportsWrite: false,
  supportsCreateCalendar: false,
  supportsPush: false,
  supportsMultiAccount: false,
  requiresMemryAccount: false,
  mirrorScope: 'device',
  sourceScope: 'synced',
  incrementalMode: 'full',
  authFlow: 'url'
}

export function providerCapabilities(providerId: string): CalendarProviderCapabilities {
  return PROVIDER_CAPABILITIES[providerId] ?? UNKNOWN_PROVIDER_CAPABILITIES
}

export function isKnownProvider(providerId: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROVIDER_CAPABILITIES, providerId)
}

export function sourceCapabilities(source: { provider: string }): CalendarProviderCapabilities {
  return providerCapabilities(source.provider)
}

export function isProviderAvailableOn(
  capabilities: Pick<CalendarProviderCapabilities, 'platforms'>,
  platform: string = process.platform
): boolean {
  return !capabilities.platforms || (capabilities.platforms as string[]).includes(platform)
}
