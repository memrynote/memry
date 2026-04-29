import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import type { GoogleCalendarDescriptorRecord } from '@memry/contracts/calendar-api'

export interface CalendarPickerProps {
  calendars: GoogleCalendarDescriptorRecord[]
  value: string | null
  onChange: (next: string | null) => void
  isLoading?: boolean
  disabled?: boolean
  /** Label shown for the "use the default calendar" option. */
  defaultOptionLabel?: string
  className?: string
  id?: string
}

const DEFAULT_SENTINEL = '__default__'

export function CalendarPicker({
  calendars,
  value,
  onChange,
  isLoading = false,
  disabled = false,
  defaultOptionLabel,
  className,
  id
}: CalendarPickerProps) {
  const { t } = useT('calendar')
  const selectValue = value ?? DEFAULT_SENTINEL
  const handleChange = (next: string): void => {
    onChange(next === DEFAULT_SENTINEL ? null : next)
  }

  return (
    <select
      id={id}
      aria-label={t('form.target-calendar')}
      className={cn(
        'flex h-9 w-full items-center rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      value={selectValue}
      disabled={disabled || isLoading}
      onChange={(event) => handleChange(event.target.value)}
    >
      <option value={DEFAULT_SENTINEL}>
        {isLoading
          ? t('state.loading-calendars')
          : (defaultOptionLabel ?? t('form.use-default-calendar'))}
      </option>
      {calendars.map((calendar) => (
        <option key={calendar.id} value={calendar.id}>
          {calendar.title}
          {calendar.isPrimary ? ` (${t('form.primary-suffix')})` : ''}
        </option>
      ))}
    </select>
  )
}
