import { useEffect, useState, type ReactNode } from 'react'
import type { CalendarProviderDescriptor } from '@memry/contracts/calendar-api'
import { useT } from '@memry/i18n/renderer'
import { SettingsGroup } from '@/components/settings/settings-primitives'
import { GoogleCalendarConnection } from '@/components/settings/google-calendar-connection'
import { IcsCalendarSubscriptions } from '@/components/settings/ics-calendar-subscriptions'
import { GenericCalendarProviderPanel } from '@/components/settings/generic-calendar-provider-panel'
import { calendarService } from '@/services/calendar-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('CalendarProviderSections')

// What main has always offered, shown until `calendar:list-providers` answers
// so the page does not flash empty. Main filters providers by platform; the
// real list replaces this on the first render that has it.
const FIRST_PAINT_PROVIDERS: CalendarProviderDescriptor[] = [
  {
    id: 'google',
    capabilities: {
      supportsWrite: true,
      supportsCreateCalendar: true,
      supportsPush: true,
      supportsMultiAccount: true,
      requiresMemryAccount: true,
      mirrorScope: 'synced',
      sourceScope: 'synced',
      incrementalMode: 'sync-token',
      authFlow: 'oauth2'
    }
  },
  {
    id: 'ics',
    capabilities: {
      supportsWrite: false,
      supportsCreateCalendar: false,
      supportsPush: false,
      supportsMultiAccount: false,
      requiresMemryAccount: false,
      mirrorScope: 'device',
      sourceScope: 'synced',
      incrementalMode: 'conditional-get',
      authFlow: 'url'
    }
  }
]

function useProviderName(): (providerId: string) => string {
  const { t } = useT('settings')
  return (providerId) => {
    switch (providerId) {
      case 'google':
        return t('calendar.google.name')
      case 'ics':
        return t('calendar.subscriptions.name')
      case 'caldav':
        return t('calendar.providers.caldav.name')
      default:
        return providerId
    }
  }
}

/**
 * One provider's settings, picked by its auth flow (#1395). Google and ICS
 * keep their own components, unchanged; every other provider gets the
 * capability-driven panel.
 */
function providerSettingsBody(provider: CalendarProviderDescriptor): ReactNode {
  const { authFlow } = provider.capabilities
  if (authFlow === 'oauth2' && provider.id === 'google') return <GoogleCalendarConnection />
  if (authFlow === 'url' && provider.id === 'ics') return <IcsCalendarSubscriptions />
  return <GenericCalendarProviderPanel provider={provider} />
}

/**
 * Settings → Calendar, one section per provider this platform offers (#1395).
 * The list comes from main, which drops providers whose `platforms` exclude
 * this OS, so such a provider is absent here rather than disabled.
 */
export function CalendarProviderSections(): React.JSX.Element {
  const providerName = useProviderName()
  const [providers, setProviders] = useState<CalendarProviderDescriptor[]>(FIRST_PAINT_PROVIDERS)

  // The list is fixed for the life of the process (it depends on the build
  // and the OS), so one read on mount is enough.
  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => calendarService.listProviders())
      .then((response) => {
        if (!cancelled) setProviders(response.providers)
      })
      .catch((error: unknown) => {
        log.warn('Could not list calendar providers; showing the built-in ones', error)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <>
      {providers.map((provider) => (
        <div key={provider.id} data-testid={`calendar-provider-section-${provider.id}`}>
          <SettingsGroup label={providerName(provider.id)}>
            {providerSettingsBody(provider)}
          </SettingsGroup>
        </div>
      ))}
    </>
  )
}
