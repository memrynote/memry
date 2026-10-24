import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import type { GoogleCalendarDescriptorRecord } from '@memry/contracts/calendar-api'

export interface CalendarPickerGroup {
  /** Shown as the group heading, e.g. the provider's name. */
  label: string
  calendars: GoogleCalendarDescriptorRecord[]
}

export interface CalendarPickerProps {
  calendars: GoogleCalendarDescriptorRecord[]
  /**
   * #2372: writable calendars from every provider, grouped by provider. With
   * one group or none the picker stays the flat list it always was.
   */
  groups?: CalendarPickerGroup[]
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
  groups,
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
      {groups && groups.length > 1
        ? groups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.calendars.map((calendar) => (
                <option key={calendar.id} value={calendar.id}>
                  {calendar.title}
                  {calendar.isPrimary ? ` (${t('form.primary-suffix')})` : ''}
                </option>
              ))}
            </optgroup>
          ))
        : calendars.map((calendar) => (
            <option key={calendar.id} value={calendar.id}>
              {calendar.title}
              {calendar.isPrimary ? ` (${t('form.primary-suffix')})` : ''}
            </option>
          ))}
    </select>
  )
}
