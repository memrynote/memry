import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useT } from '@memry/i18n/renderer'
import { getI18n } from 'react-i18next'

import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { DatePickerContent } from '@/components/tasks/date-picker-content'
import {
  CALENDAR_EVENT_COLORS,
  calendarColorHex,
  type CalendarEventColor
} from '@memry/contracts/calendar-colors'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { inkOnCalendarColor } from '@/lib/calendar-colors'
import { AlignLeft, Calendar2, Check, Folder, Palette } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { type ClockFormat, formatTimeString } from '@/lib/time-format'
import { cn } from '@/lib/utils'

import { toLocalDateString } from './date-utils'
import { CalendarPicker, type CalendarPickerGroup } from './calendar-picker'
import { CalendarEventMetadata } from './calendar-event-metadata'
import { EventProjectField } from './event-project-field'
import {
  CalendarCardAction,
  CalendarCardActionBar,
  CalendarCardSection,
  MOD_KEY_LABEL,
  isModEnter
} from './calendar-card'
import { formatDurationShort } from './chip-duration'
import { useGoogleCalendars } from '@/hooks/use-google-calendars'
import { useOtherWritableCalendars } from '@/hooks/use-writable-calendars'
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
  const date = draftValueToDate(value, isAllDay)
  if (!date) return pickDateLabel
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' })
  }).format(date)
}

/** Minutes between two timed draft values (`YYYY-MM-DDTHH:mm`), or null. */
function draftDurationMinutes(draft: CalendarEventDraft): number | null {
  if (draft.isAllDay || !draft.startAt || !draft.endAt) return null
  const minutes = Math.round(
    (new Date(draft.endAt).getTime() - new Date(draft.startAt).getTime()) / 60_000
  )
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null
}

interface DateTimeFieldProps {
  label: string
  value: string
  isAllDay: boolean
  onChange: (next: string) => void
  clockFormat: ClockFormat
  locale: string
  pickDateLabel: string
  /** Hide the date when it repeats the start's, so a same-day range reads "Tue, Sep 22 · 10:00 – 11:30". */
  hideDate?: boolean
}

function DateTimeField({
  label,
  value,
  isAllDay,
  onChange,
  clockFormat,
  locale,
  pickDateLabel,
  hideDate = false
}: DateTimeFieldProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const date = draftValueToDate(value, isAllDay)
  const time = draftValueToTime(value, isAllDay)
  const dateLabel = formatDateLabel(value, isAllDay, locale, pickDateLabel)
  const timeLabel = time ? formatTimeString(time, clockFormat) : null
  const showDate = !hideDate || isAllDay || !timeLabel

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${[dateLabel, isAllDay ? null : timeLabel].filter(Boolean).join(' ')}`}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-[5px] px-1.5 text-[13px] text-foreground tabular-nums',
            'transition-colors hover:bg-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-(--tint-ring)'
          )}
        >
          {showDate && <span>{dateLabel}</span>}
          {!isAllDay && timeLabel && (
            <>
              {showDate && (
                <span aria-hidden className="text-muted-foreground">
                  ·
                </span>
              )}
              <span>{timeLabel}</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      {/* Same cap as the due-date badge: a raw `PopoverContent` never applies
          the available height Radix measures, and this field is reached from an
          event popover that can itself sit low in the calendar grid. */}
      <PopoverContent
        className="w-auto p-0 overflow-clip flex flex-col max-h-(--radix-popover-content-available-height)"
        align="start"
        sideOffset={6}
      >
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

/** A detail row: a fixed 16px icon lane, then the control. */
function DetailRow({
  icon,
  children,
  align = 'center'
}: {
  icon: ReactNode
  children: ReactNode
  align?: 'center' | 'start'
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex min-h-8 gap-2.5 px-2',
        align === 'center' ? 'items-center' : 'items-start py-1.5'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex w-4 shrink-0 justify-center text-muted-foreground [&_svg]:size-4',
          align === 'start' && 'pt-0.5'
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
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

  const endValue = draft.endAt || draft.startAt
  const sameDay =
    extractDatePart(draft.startAt, draft.isAllDay) === extractDatePart(endValue, draft.isAllDay)
  const durationMinutes = draftDurationMinutes(draft)
  const saveLabel = isSaving
    ? tCommon('state.saving')
    : mode === 'create'
      ? tCommon('button.create')
      : tCommon('button.save')

  return (
    <div
      className="flex flex-col"
      onKeyDown={(e) => {
        // ⌘↵ saves from any field, including the notes textarea where a plain
        // ↵ has to stay a newline.
        if (isModEnter(e) && draft.title.trim()) {
          e.preventDefault()
          void submit()
        }
      }}
    >
      <div className="flex flex-col gap-1.5 px-3.5 pb-3">
        <input
          ref={titleRef}
          placeholder={t('form.new-event-placeholder')}
          value={draft.title}
          onChange={(e) => onDraftChange({ ...draft, title: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isModEnter(e) && draft.title.trim()) {
              e.preventDefault()
              void submit()
            }
          }}
          disabled={isSaving}
          className={cn(
            'w-full bg-transparent text-[17px] leading-[22px] font-semibold tracking-[-0.01em] text-(--cal-ink) outline-none',
            'placeholder:font-medium placeholder:text-muted-foreground disabled:opacity-50'
          )}
        />

        <div className="-ms-1.5 flex flex-wrap items-center gap-x-0.5">
          <DateTimeField
            label={t('form.start')}
            value={draft.startAt}
            isAllDay={draft.isAllDay}
            onChange={(next) => onDraftChange({ ...draft, startAt: next })}
            clockFormat={clockFormat}
            locale={i18n.language}
            pickDateLabel={t('time.pick-a-date')}
          />
          <span aria-hidden className="text-[13px] text-muted-foreground">
            –
          </span>
          <DateTimeField
            label={t('form.end')}
            value={endValue}
            isAllDay={draft.isAllDay}
            onChange={(next) => onDraftChange({ ...draft, endAt: next })}
            clockFormat={clockFormat}
            locale={i18n.language}
            pickDateLabel={t('time.pick-a-date')}
            hideDate={sameDay}
          />
          {durationMinutes !== null && (
            <span className="px-1.5 text-[13px] text-muted-foreground tabular-nums">
              {formatDurationShort(durationMinutes, t)}
            </span>
          )}
        </div>

        <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={draft.isAllDay}
            onCheckedChange={(checked) => handleAllDayToggle(checked === true)}
            aria-label={t('time.all-day')}
            className="size-3.5 rounded-[4px]"
          />
          {t('time.all-day')}
        </label>
      </div>

      <CalendarCardSection className="flex flex-col gap-0.5 px-1.5 py-1.5">
        {/* EventProjectField renders nothing for an unsaved edit (canvas cards
            mount the form without an id), so skip its row too. */}
        {(mode === 'create' || eventId) && (
          <DetailRow icon={<Folder />}>
            <EventProjectField
              mode={mode}
              eventId={eventId}
              value={draft.projectId}
              onChange={(projectId) => onDraftChange({ ...draft, projectId })}
              disabled={isSaving}
              hideLabel
            />
          </DetailRow>
        )}

        <TargetCalendarField
          value={draft.targetCalendarId}
          onChange={(next) => onDraftChange({ ...draft, targetCalendarId: next })}
          disabled={isSaving}
        />

        <DetailRow icon={<Palette />}>
          <EventColorField
            value={draft.color}
            onChange={(color) => onDraftChange({ ...draft, color })}
            disabled={isSaving}
          />
        </DetailRow>

        <DetailRow icon={<AlignLeft />} align="start">
          <Textarea
            placeholder={t('form.notes-url-placeholder')}
            value={draft.description}
            onChange={(e) => onDraftChange({ ...draft, description: e.target.value })}
            disabled={isSaving}
            rows={2}
            className="min-h-0 resize-none border-0 bg-transparent p-0 text-[13px] shadow-none focus-visible:ring-0"
          />
        </DetailRow>
      </CalendarCardSection>

      {readOnlyMetadata && mode === 'edit' && <CalendarEventMetadata {...readOnlyMetadata} />}

      {errorMessage && (
        <p
          data-testid="event-edit-error"
          role="alert"
          className="border-t border-border/70 px-3.5 py-2 text-xs text-destructive"
        >
          {errorMessage}
        </p>
      )}

      <CalendarCardActionBar
        start={
          <CalendarCardAction
            emphasis
            data-testid="event-edit-save"
            label={saveLabel}
            keys={[MOD_KEY_LABEL, '↵']}
            disabled={!draft.title.trim() || isSaving}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.preventDefault()
              void submit()
            }}
            onClick={() => void submit()}
          />
        }
        end={
          <CalendarCardAction
            label={tCommon('button.cancel')}
            keys={['Esc']}
            onClick={onDismiss}
            disabled={isSaving}
          />
        }
      />
    </div>
  )
}

interface EventColorFieldProps {
  value: CalendarEventColor | null
  onChange: (next: CalendarEventColor | null) => void
  disabled?: boolean
}

function EventColorField({ value, onChange, disabled }: EventColorFieldProps) {
  const { t } = useT('calendar')
  const labelId = useId()
  // Google's event colours, in Google's order. Light ones (Banana) sit close to
  // the popover, so every swatch carries a border to keep its edge visible.
  const swatchClass = cn(
    'flex size-[18px] items-center justify-center rounded-full border border-border',
    'transition-transform duration-100 hover:scale-110 focus:outline-none',
    'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
    'focus-visible:ring-offset-popover disabled:pointer-events-none'
  )
  const defaultLabel = t('form.default-color')

  return (
    <div className="flex items-center">
      <span id={labelId} className="sr-only">
        {t('form.color')}
      </span>
      <div role="group" aria-labelledby={labelId} className="flex flex-wrap gap-1">
        <button
          type="button"
          className={cn(swatchClass, 'bg-background text-foreground')}
          aria-label={defaultLabel}
          title={defaultLabel}
          aria-pressed={value === null}
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          {value === null && <Check className="size-3" />}
        </button>
        {CALENDAR_EVENT_COLORS.map((color) => {
          const hex = calendarColorHex(color)
          const label = t(`calendar-color.${color}`)
          return (
            <button
              key={color}
              type="button"
              className={swatchClass}
              style={{ backgroundColor: hex, color: inkOnCalendarColor(hex) }}
              aria-label={label}
              title={label}
              aria-pressed={value === color}
              disabled={disabled}
              onClick={() => onChange(color)}
            >
              {value === color && <Check className="size-3" />}
            </button>
          )
        })}
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
  const others = useOtherWritableCalendars()
  const { t } = useT('calendar')
  const googleCalendars = data?.calendars ?? []
  // #2372: writable calendars from every provider, grouped by provider. With
  // Google alone this is exactly the Google list it always was.
  const groups: CalendarPickerGroup[] = [
    ...(googleCalendars.length > 0
      ? [{ label: t('providers.google.name'), calendars: googleCalendars }]
      : []),
    ...others.groups.map((group) => ({
      label: group.provider === 'caldav' ? t('providers.caldav.name') : group.provider,
      calendars: group.calendars
    }))
  ]
  const calendars = groups.flatMap((group) => group.calendars)
  // Only surface the picker when a writable provider is connected
  // (empty list = not connected OR no calendars yet).
  if (!isLoading && calendars.length === 0) return null

  // A default on another provider overrides Google's own default.
  const otherDefault = others.groups.find((group) => group.currentDefaultId)
  const currentDefaultId = otherDefault?.currentDefaultId ?? data?.currentDefaultId ?? null
  const currentDefaultLabel = currentDefaultId
    ? (calendars.find((c) => c.id === currentDefaultId)?.title ?? currentDefaultId)
    : null
  const defaultLabel = currentDefaultLabel
    ? t('form.use-default-calendar-with-name', { calendar: currentDefaultLabel })
    : t('form.use-memry-calendar-default')

  return (
    <DetailRow icon={<Calendar2 />}>
      <label className="flex flex-col text-sm">
        <span className="sr-only">{t('form.google-calendar')}</span>
        <CalendarPicker
          calendars={calendars}
          groups={groups}
          value={value}
          onChange={onChange}
          isLoading={isLoading}
          disabled={disabled}
          defaultOptionLabel={defaultLabel}
          className="h-7 -ms-1.5 border-0 bg-transparent px-1.5 text-[13px] shadow-none hover:bg-accent"
        />
      </label>
    </DetailRow>
  )
}

export default CalendarEventForm
