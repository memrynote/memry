import type {
  CalendarProviderAccountStatus,
  CalendarProviderDescriptor
} from '@memry/contracts/calendar-api'
import { useT } from '@memry/i18n/renderer'
import { CaldavConnectForm } from '@/components/settings/caldav-connect-form'
import { GenericCalendarProviderPanel } from '@/components/settings/generic-calendar-provider-panel'

/**
 * CalDAV in Settings → Calendar (#1401): the capability-driven panel with the
 * preset connect form, and reconnect copy that names the real failure.
 */
export function CaldavProviderPanel({
  provider,
  name
}: {
  provider: CalendarProviderDescriptor
  name?: string
}): React.JSX.Element {
  const { t } = useT('settings')

  const describeReconnect = (account: CalendarProviderAccountStatus): string => {
    if (account.reconnectReason === 'missing') return t('calendar.caldav.reconnect.missing')
    // Resetting an Apple ID password revokes every app-specific password: the
    // most common reason an iCloud calendar "just stopped".
    if (account.preset === 'icloud') return t('calendar.caldav.reconnect.icloudRevoked')
    return t('calendar.caldav.reconnect.rejected')
  }

  return (
    <GenericCalendarProviderPanel
      provider={provider}
      name={name}
      describeReconnect={describeReconnect}
      renderConnectForm={({ onConnected, reconnect }) => (
        <CaldavConnectForm
          provider={provider}
          onConnected={onConnected}
          reconnect={
            reconnect?.serverUrl && reconnect.username
              ? {
                  serverUrl: reconnect.serverUrl,
                  username: reconnect.username,
                  preset: reconnect.preset ?? null
                }
              : undefined
          }
        />
      )}
    />
  )
}
