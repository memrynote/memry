import { useEffect, useState } from 'react'
import type { ProviderCalendarDescriptorRecord } from '@memry/contracts/calendar-api'
import { useT } from '@memry/i18n/renderer'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { calendarService } from '@/services/calendar-service'

const log = createLogger('CalendarDefaultTarget')
const NOT_DEFAULT = '__not_default__'

/**
 * Make one of this provider's calendars the default write target (#2372):
 * where tasks, reminders, inbox snoozes and events without a chosen calendar
 * go. Exactly one provider holds the default.
 */
export function CalendarDefaultTargetRow({
  providerId
}: {
  providerId: string
}): React.JSX.Element | null {
  const { t } = useT('settings')
  const [calendars, setCalendars] = useState<ProviderCalendarDescriptorRecord[]>([])
  const [value, setValue] = useState<string>(NOT_DEFAULT)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => calendarService.listProviderCalendars({ provider: providerId }))
      .then((listed) => {
        if (cancelled) return
        setCalendars(listed.calendars)
        setValue(listed.currentDefaultId ?? NOT_DEFAULT)
      })
      .catch((cause: unknown) => log.warn('Could not list calendars for the default target', cause))
    return () => {
      cancelled = true
    }
  }, [providerId])

  if (calendars.length === 0) return null

  const choose = async (next: string): Promise<void> => {
    const previous = value
    setValue(next)
    setError(null)
    try {
      const result = await calendarService.setDefaultProviderCalendar({
        provider: providerId,
        calendarId: next === NOT_DEFAULT ? null : next
      })
      if (!result.success) throw new Error(result.error)
    } catch (cause) {
      setValue(previous)
      setError(extractErrorMessage(cause, t('calendar.providers.defaultTarget.error')))
    }
  }

  return (
    <div className="flex items-start justify-between gap-3 border-t border-border/60 pt-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px]/4 font-medium text-foreground">
          {t('calendar.providers.defaultTarget.label')}
        </span>
        <p className="text-xs/4 text-muted-foreground">
          {t('calendar.providers.defaultTarget.description')}
        </p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <select
        value={value}
        onChange={(event) => void choose(event.target.value)}
        aria-label={t('calendar.providers.defaultTarget.label')}
        className="h-[30px] max-w-[12rem] shrink-0 rounded-[7px] border border-input bg-transparent px-2 text-xs"
        data-testid={`calendar-provider-default-target-${providerId}`}
      >
        <option value={NOT_DEFAULT}>{t('calendar.providers.defaultTarget.none')}</option>
        {calendars.map((calendar) => (
          <option key={calendar.id} value={calendar.id}>
            {calendar.title}
          </option>
        ))}
      </select>
    </div>
  )
}
