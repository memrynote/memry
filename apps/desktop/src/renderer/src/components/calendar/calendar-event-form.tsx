import { useEffect, useRef, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { getI18n } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { DatePickerContent } from '@/components/tasks/date-picker-content'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { CalendarIcon } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { type ClockFormat, formatTimeString } from '@/lib/time-format'
import { cn } from '@/lib/utils'

import { toLocalDateString } from './date-utils'
import { CalendarPicker } from './calendar-picker'
import { CalendarEventMetadata } from './calendar-event-metadata'
import { ItemProjectChips } from '@/components/tasks/projects/item-project-chips'
import { useGoogleCalendars } from '@/hooks/use-google-calendars'
import type { CalendarEventDraft } from './types'
import type { CalendarEventReadOnlyMetadata } from './calendar-event-popover'

export interface CalendarEventFormProps {
  mode: 'create' | 'edit'
  /** Saved event id; absent/null while the popover is drafting a new, unsaved event. */
  eventId?: string | null
  draft: CalendarEventDraft
  isSaving: boolean
  onDraftChange: (next: CalendarEventDraft) => void
  onSave: () => void | Promise<void>
  onDismiss: () => void
  /** M5: read-only rich metadata (attendees/reminders/visibility/Meet link) shown below the form. */
  readOnlyMetadata?: CalendarEventReadOnlyMetadata
  /**
   * Focus the title on mount. Off for idle canvas cards, which mount this form
   * purely to paint — several of them at once would fight over focus and steal
   * it from the canvas.
   */
  autoFocus?: boolean
}

function extractDatePart(value: string, isAllDay: boolean): string | null {
  if (!value) return null
  return isAllDay ? value : value.split('T')[0]
}

function draftValueToDate(value: string, isAllDay: boolean): Date | null {
  const datePart = extractDatePart(value, isAllDay)
  if (!datePart) return null
  const [y, m, d] = datePart.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d)
}

function draftValueToTime(value: string, isAllDay: boolean): string | null {
  if (isAllDay || !value) return null
  return value.split('T')[1] ?? null
}

function combineDateTime(date: Date, time: string | null, isAllDay: boolean): string {
  const datePart = toLocalDateString(date)
  if (isAllDay) return datePart
  return `${datePart}T${time ?? '09:00'}`
}

function formatDateLabel(
  value: string,
  isAllDay: boolean,
  locale: string,
  pickDateLabel: string
): string {
  const datePart = extractDatePart(value, isAllDay)
  if (!datePart) return pickDateLabel
  const [y, m, d] = datePart.split('-').map(Number)
  if (!y || !m || !d) return pickDateLabel
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(new Date(y, m - 1, d))
}

interface DateTimeFieldProps {
  label: string
  value: string
  isAllDay: boolean
  onChange: (next: string) => void
  clockFormat: ClockFormat
  locale: string
  pickDateLabel: string
}

function DateTimeField({
  label,
  value,
  isAllDay,
  onChange,
  clockFormat,
  locale,
  pickDateLabel
}: DateTimeFieldProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const date = draftValueToDate(value, isAllDay)
  const time = draftValueToTime(value, isAllDay)
  const dateLabel = formatDateLabel(value, isAllDay, locale, pickDateLabel)
  const timeLabel = time ? formatTimeString(time, clockFormat) : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex w-full items-center justify-between rounded-md border border-border bg-background px-3 py-2 text-sm',
            'transition-colors hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring'
          )}
        >
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            <span>{dateLabel}</span>
            {!isAllDay && timeLabel && <span className="text-muted-foreground">{timeLabel}</span>}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end" sideOffset={6}>
        <DatePickerContent
          selected={date ?? undefined}
          onSelect={(next) => {
            if (!next) return
            onChange(combineDateTime(next, time, isAllDay))
          }}
          showRemoveDate={false}
          time={isAllDay ? null : time}
          onTimeChange={
            isAllDay
              ? undefined
              : (nextTime) => {
                  const base = date ?? new Date()
                  onChange(combineDateTime(base, nextTime ?? '09:00', false))
                }
          }
        />
      </PopoverContent>
    </Popover>
  )
}

export function CalendarEventForm({
  mode,
  eventId,
  draft,
  isSaving,
  onDraftChange,
  onSave,
  onDismiss,
  readOnlyMetadata,
  autoFocus = true
}: CalendarEventFormProps): React.JSX.Element {
  const titleRef = useRef<HTMLInputElement>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const {
    settings: { clockFormat }
  } = useGeneralSettings()
  const { t, i18n } = useT('calendar')
  const { t: tCommon } = useT('common')

  useEffect(() => {
    // Focus once on mount, mirroring the popover's onOpenAutoFocus behavior.
    if (autoFocus) {
      titleRef.current?.focus()
    }
  }, [autoFocus])

  async function submit(): Promise<void> {
    if (!draft.title.trim() || isSaving) return
    setErrorMessage(null)
    try {
      await onSave()
    } catch (error) {
      setErrorMessage(
        extractErrorMessage(
          error,
          getI18n().getFixedT(null, 'calendar')('phaseI.errors.couldNotSaveEventTryAgain')
        )
      )
    }
  }

  function handleAllDayToggle(nextAllDay: boolean): void {
    const startDate = draft.startAt.slice(0, 10) || toLocalDateString(new Date())
    const endDate = draft.endAt ? draft.endAt.slice(0, 10) : startDate
    if (nextAllDay) {
      onDraftChange({ ...draft, isAllDay: true, startAt: startDate, endAt: endDate })
      return
    }
    onDraftChange({
      ...draft,
      isAllDay: false,
      startAt: `${startDate}T09:00`,
      endAt: `${endDate}T10:00`
    })
  }

  return (
    <div className="space-y-3">
      <Input
        ref={titleRef}
        placeholder={t('form.new-event-placeholder')}
        value={draft.title}
        onChange={(e) => onDraftChange({ ...draft, title: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.title.trim()) {
            e.preventDefault()
            void submit()
          }
        }}
        disabled={isSaving}
      />

      {mode === 'edit' && eventId && (
        <ItemProjectChips itemType="calendar_event" itemId={eventId} />
      )}

      <label className="flex items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2 text-sm">
        <span className="flex items-center gap-2 text-muted-foreground">
          <CalendarIcon size={14} />
          {t('time.all-day')}
        </span>
        <Checkbox
          checked={draft.isAllDay}
          onCheckedChange={(checked) => handleAllDayToggle(checked === true)}
          aria-label={t('time.all-day')}
        />
      </label>

      <DateTimeField
        label={t('form.start')}
        value={draft.startAt}
        isAllDay={draft.isAllDay}
        onChange={(next) => onDraftChange({ ...draft, startAt: next })}
        clockFormat={clockFormat}
        locale={i18n.language}
        pickDateLabel={t('time.pick-a-date')}
      />

      <DateTimeField
        label={t('form.end')}
        value={draft.endAt || draft.startAt}
        isAllDay={draft.isAllDay}
        onChange={(next) => onDraftChange({ ...draft, endAt: next })}
        clockFormat={clockFormat}
        locale={i18n.language}
        pickDateLabel={t('time.pick-a-date')}
      />

      <Textarea
        placeholder={t('form.notes-url-placeholder')}
        value={draft.description}
        onChange={(e) => onDraftChange({ ...draft, description: e.target.value })}
        disabled={isSaving}
        rows={3}
        className="resize-none text-sm"
      />

      <TargetCalendarField
        value={draft.targetCalendarId}
        onChange={(next) => onDraftChange({ ...draft, targetCalendarId: next })}
        disabled={isSaving}
      />

      {readOnlyMetadata && mode === 'edit' && (
        <div className="border-t border-border pt-3">
          <CalendarEventMetadata {...readOnlyMetadata} />
        </div>
      )}

      {errorMessage && (
        <p data-testid="event-edit-error" role="alert" className="text-xs text-destructive">
          {errorMessage}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss} disabled={isSaving}>
          {tCommon('button.cancel')}
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid="event-edit-save"
          disabled={!draft.title.trim() || isSaving}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.preventDefault()
            void submit()
          }}
          onClick={() => void submit()}
        >
          {isSaving
            ? tCommon('state.saving')
            : mode === 'create'
              ? tCommon('button.create')
              : tCommon('button.save')}
        </Button>
      </div>
    </div>
  )
}

interface TargetCalendarFieldProps {
  value: string | null
  onChange: (next: string | null) => void
  disabled?: boolean
}

function TargetCalendarField({ value, onChange, disabled }: TargetCalendarFieldProps) {
  const { data, isLoading } = useGoogleCalendars()
  const { t } = useT('calendar')
  const calendars = data?.calendars ?? []
  // Only surface the picker when the user actually has Google connected
  // (empty list = not connected OR no calendars yet).
  if (!isLoading && calendars.length === 0) return null

  const currentDefaultLabel = data?.currentDefaultId
    ? (data.calendars.find((c) => c.id === data.currentDefaultId)?.title ?? data.currentDefaultId)
    : null
  const defaultLabel = currentDefaultLabel
    ? t('form.use-default-calendar-with-name', { calendar: currentDefaultLabel })
    : t('form.use-memry-calendar-default')

  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{t('form.google-calendar')}</span>
      <CalendarPicker
        calendars={calendars}
        value={value}
        onChange={onChange}
        isLoading={isLoading}
        disabled={disabled}
        defaultOptionLabel={defaultLabel}
      />
    </label>
  )
}

export default CalendarEventForm
