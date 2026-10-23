import type { CalendarWriterCompatResponse } from '@memry/contracts/calendar-api'
import { useT } from '@memry/i18n/renderer'
import { Checkbox } from '@/components/ui/checkbox'

/** True when connecting must wait for the user to accept the outdated-devices risk (#1396). */
export function writerCompatNeedsAcknowledgement(
  compat: CalendarWriterCompatResponse | null
): boolean {
  return (
    compat !== null && compat.required && (!compat.verified || compat.outdatedDevices.length > 0)
  )
}

/**
 * The devices too old to share a second writable calendar provider, and what
 * happens if the user connects anyway (#1396). The checkbox is the explicit
 * acknowledgement main requires.
 */
export function CalendarWriterCompatNotice({
  compat,
  acknowledged,
  onAcknowledgedChange
}: {
  compat: CalendarWriterCompatResponse
  acknowledged: boolean
  onAcknowledgedChange: (acknowledged: boolean) => void
}): React.JSX.Element {
  const { t } = useT('settings')
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 border-s-2 border-amber-500 py-1 ps-3 text-xs/4 text-foreground"
      data-testid="calendar-writer-compat-warning"
    >
      <p>
        {compat.verified
          ? t('calendar.providers.compat.outdated', { version: compat.minVersion })
          : t('calendar.providers.compat.unverified')}
      </p>
      {compat.outdatedDevices.length > 0 && (
        <ul className="list-disc ps-4">
          {compat.outdatedDevices.map((device) => (
            <li key={device.id}>
              {device.name}
              {' · '}
              {device.appVersion ?? t('calendar.providers.compat.unknownVersion')}
            </li>
          ))}
        </ul>
      )}
      <p>{t('calendar.providers.compat.consequence')}</p>
      <label className="flex items-center gap-2">
        <Checkbox
          checked={acknowledged}
          onCheckedChange={(checked) => onAcknowledgedChange(checked === true)}
          aria-label={t('calendar.providers.compat.acknowledge')}
        />
        <span>{t('calendar.providers.compat.acknowledge')}</span>
      </label>
    </div>
  )
}
