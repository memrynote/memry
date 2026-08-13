import { describe, expect, it } from 'vitest'
import { ensureBuiltInCalendarProviders } from './builtin'
import {
  getProvider,
  getProviderCapabilities,
  listProviders,
  registerProvider,
  unsupportedProviderMessage,
  type CalendarProviderDefinition
} from './registry'

describe('calendar provider registry', () => {
  it('resolves google from the built-in registration', () => {
    ensureBuiltInCalendarProviders()

    const google = getProvider('google')

    expect(google?.id).toBe('google')
    expect(google?.capabilities).toEqual({
      supportsWrite: true,
      supportsCreateCalendar: true,
      supportsPush: true,
      supportsMultiAccount: true,
      incrementalMode: 'sync-token',
      authFlow: 'oauth2'
    })
  })

  it('returns null for a provider this build does not ship', () => {
    ensureBuiltInCalendarProviders()

    expect(getProvider('caldav')).toBeNull()
    expect(getProviderCapabilities('caldav')).toBeNull()
  })

  it('keeps the unsupported-provider message byte-identical to the old guards', () => {
    expect(unsupportedProviderMessage('caldav')).toBe('Unsupported calendar provider: caldav')
    expect(unsupportedProviderMessage('ics')).toBe('Unsupported calendar provider: ics')
  })

  it('registering a second provider does not disturb the first', () => {
    ensureBuiltInCalendarProviders()
    const readOnly = {
      id: 'test-read-only',
      capabilities: {
        supportsWrite: false,
        supportsCreateCalendar: false,
        supportsPush: false,
        supportsMultiAccount: false,
        incrementalMode: 'conditional-get',
        authFlow: 'url'
      }
    } as CalendarProviderDefinition

    registerProvider(readOnly)

    expect(getProvider('test-read-only')?.capabilities.supportsWrite).toBe(false)
    expect(getProvider('google')?.capabilities.supportsWrite).toBe(true)
    expect(listProviders().map((definition) => definition.id)).toEqual(
      expect.arrayContaining(['google', 'test-read-only'])
    )
  })
})
