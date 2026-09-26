import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CalendarProviderDescriptor } from '@memry/contracts/calendar-api'
import { useT } from '@memry/i18n/renderer'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Plus } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { SETTINGS_GROUP_LABEL } from '@/components/settings/settings-primitives'
import {
  CALENDAR_BORDERED_BUTTON,
  CalendarConnectRegistryProvider,
  type CalendarConnectRegistry
} from '@/components/settings/calendar-provider-row'
import { GoogleCalendarConnection } from '@/components/settings/google-calendar-connection'
import { IcsCalendarSubscriptions } from '@/components/settings/ics-calendar-subscriptions'
import { CaldavProviderPanel } from '@/components/settings/caldav-provider-panel'
import { MacosCalendarProviderPanel } from '@/components/settings/macos-calendar-provider-panel'
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
      case 'apple-eventkit':
        return t('calendar.providers.appleEventKit.name')
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
function providerSettingsBody(provider: CalendarProviderDescriptor, name: string): ReactNode {
  const { authFlow } = provider.capabilities
  if (authFlow === 'oauth2' && provider.id === 'google') return <GoogleCalendarConnection />
  if (authFlow === 'url' && provider.id === 'ics') return <IcsCalendarSubscriptions />
  if (authFlow === 'basic' && provider.id === 'caldav')
    return <CaldavProviderPanel provider={provider} name={name} />
  // macOS only: main never lists it on Windows or Linux (#2374).
  if (authFlow === 'os-permission' && provider.id === 'apple-eventkit')
    return <MacosCalendarProviderPanel provider={provider} name={name} />
  return <GenericCalendarProviderPanel provider={provider} name={name} />
}

/**
 * Settings → Calendar → Connected calendars, one row per provider this platform offers (#1395).
 * The list comes from main, which drops providers whose `platforms` exclude
 * this OS, so such a provider is absent here rather than disabled.
 */
export function CalendarProviderSections(): React.JSX.Element {
  const { t } = useT('settings')
  const providerName = useProviderName()
  const [providers, setProviders] = useState<CalendarProviderDescriptor[]>(FIRST_PAINT_PROVIDERS)
  const connectHandlers = useRef(new Map<string, () => void>())
  const connectRegistry = useMemo<CalendarConnectRegistry>(
    () => ({
      register: (providerId, handler) => {
        connectHandlers.current.set(providerId, handler)
        return () => {
          if (connectHandlers.current.get(providerId) === handler) {
            connectHandlers.current.delete(providerId)
          }
        }
      }
    }),
    []
  )

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
    <div className="flex flex-col pb-8">
      <div className="flex items-center justify-between gap-3 pb-1.5">
        <h4 className={cn(SETTINGS_GROUP_LABEL, 'pb-0')}>{t('calendar.v2.groups.connected')}</h4>
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(CALENDAR_BORDERED_BUTTON, 'inline-flex h-6 items-center gap-1 px-2')}
            data-testid="calendar-add-calendar"
          >
            <Plus className="size-3" aria-hidden />
            {t('calendar.v2.addCalendar')}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {providers.map((provider) => (
              <DropdownMenuItem
                key={provider.id}
                data-testid={`calendar-add-calendar-${provider.id}`}
                onSelect={() => connectHandlers.current.get(provider.id)?.()}
              >
                {providerName(provider.id)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <CalendarConnectRegistryProvider value={connectRegistry}>
        <div className="flex flex-col">
          {providers.map((provider) => (
            <div
              key={provider.id}
              className="border-b border-border"
              data-testid={`calendar-provider-section-${provider.id}`}
            >
              {providerSettingsBody(provider, providerName(provider.id))}
            </div>
          ))}
        </div>
      </CalendarConnectRegistryProvider>
    </div>
  )
}
