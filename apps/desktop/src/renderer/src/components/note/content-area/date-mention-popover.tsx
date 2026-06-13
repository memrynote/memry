import { useEffect, useRef, useState } from 'react'
import {
  type DateMentionDateFormat,
  type DateMentionTimeFormat,
  type RemindOffset
} from '@memry/shared/date-mention'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { DatePickerCalendar } from '@/components/tasks/date-picker-calendar'
import { parseNaturalDate } from '@/lib/natural-date-parser'
import type { ClockFormat } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import { Check, ChevronRight, Trash2 } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'

export interface DateMentionValue {
  dateISO: string
  hasTime: boolean
  dateFormat: DateMentionDateFormat
  remind: RemindOffset
  timeFormat: DateMentionTimeFormat
}

interface DateMentionPopoverProps {
  open: boolean
  anchorId: string | null
  value: DateMentionValue
  clockFormat?: ClockFormat
  onChange: (next: DateMentionValue) => void
  onClear: () => void
  onClose: () => void
}

// Row/aria labels go through t() (notes.dateMention.*). The option labels below
// (date format + remind offsets) are kept inline in English for now — they read
// like data and are exercised by unit tests; localizing them is a follow-up.

const DATE_FORMAT_OPTIONS: ReadonlyArray<{ value: DateMentionDateFormat; label: string }> = [
  { value: 'relative', label: 'Relative' },
  { value: 'full', label: 'Full date' }
]

function clockFormatLabel(clockFormat: ClockFormat): string {
  return clockFormat === '24h' ? '24 hour' : '12 hour'
}

// The per-block time-format options. 'system' shows the inherited setting in
// parens (e.g. "Default (24 hour)") so the user sees what it resolves to.
function timeFormatOptions(
  clockFormat: ClockFormat
): ReadonlyArray<{ value: DateMentionTimeFormat; label: string }> {
  return [
    { value: 'system', label: `Default (${clockFormatLabel(clockFormat)})` },
    { value: '12h', label: '12 hour' },
    { value: '24h', label: '24 hour' }
  ]
}

// The Remind option list is dynamic on `hasTime` — matching Notion. With no
// time, sub-hour offsets are meaningless and "at" reads as "On day of event".
export function remindOptions(
  hasTime: boolean
): ReadonlyArray<{ value: RemindOffset; label: string }> {
  if (!hasTime) {
    return [
      { value: 'none', label: 'None' },
      { value: 'at', label: 'On day of event (09:00)' },
      { value: '1d', label: '1 day before (09:00)' },
      { value: '2d', label: '2 days before (09:00)' },
      { value: '1w', label: '1 week before (09:00)' }
    ]
  }
  return [
    { value: 'none', label: 'None' },
    { value: 'at', label: 'At time of event' },
    { value: '5m', label: '5 minutes before' },
    { value: '10m', label: '10 minutes before' },
    { value: '15m', label: '15 minutes before' },
    { value: '30m', label: '30 minutes before' },
    { value: '1h', label: '1 hour before' },
    { value: '2h', label: '2 hours before' },
    { value: '1d', label: '1 day before (09:00)' },
    { value: '2d', label: '2 days before (09:00)' },
    { value: '1w', label: '1 week before (09:00)' }
  ]
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function tryParseDateInput(raw: string): { y: number; mo: number; d: number } | null {
  const dmy = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (dmy) return { d: Number(dmy[1]), mo: Number(dmy[2]), y: Number(dmy[3]) }
  const nat = parseNaturalDate(raw)
  if (nat.success) {
    const dt = nat.result.date
    return { y: dt.getFullYear(), mo: dt.getMonth() + 1, d: dt.getDate() }
  }
  return null
}

/** A disclosure row: label on the left, current value + chevron on the right,
 * options revealed inline (kept simple + testable; portaled flyout is polish). */
function RowSelect<T extends string>({
  label,
  ariaLabel,
  value,
  options,
  onSelect
}: {
  label: string
  ariaLabel: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onSelect: (value: T) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)
  return (
    <div className="py-0.5">
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-md px-1 py-1 text-sm hover:bg-accent"
      >
        <span>{label}</span>
        <span className="flex items-center gap-1 text-muted-foreground">
          {current?.label ?? ''}
          <ChevronRight className="h-4 w-4" />
        </span>
      </button>
      {open && (
        <ul role="listbox" className="mt-1 rounded-md border p-1">
          {options.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                role="option"
                aria-selected={o.value === value}
                onClick={() => {
                  onSelect(o.value)
                  setOpen(false)
                }}
                className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
              >
                {o.label}
                {o.value === value && <Check className="h-4 w-4" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function DateMentionPopover({
  open,
  anchorId,
  value,
  clockFormat = '12h',
  onChange,
  onClear,
  onClose
}: DateMentionPopoverProps): React.JSX.Element {
  const { t } = useT('notes')
  // Keep the latest anchorId in a ref so the virtual anchor (read by Radix at
  // measure time) re-queries the LIVE pill each call. BlockNote inline-content
  // node views have no `update` method, so changing a dateMention's props
  // destroys and recreates its <span data-date-mention>; caching the element
  // would leave us pointing at a detached node (all-zero rect). Querying by
  // anchorId is immune to that recreation.
  const anchorIdRef = useRef<string | null>(anchorId)
  useEffect(() => {
    anchorIdRef.current = anchorId
  }, [anchorId])
  const anchorRef = useRef<{ getBoundingClientRect: () => DOMRect }>({
    getBoundingClientRect: () => {
      const id = anchorIdRef.current
      if (!id) return new DOMRect()
      const el = document.querySelector<HTMLElement>(
        `[data-date-mention][data-anchor-id="${CSS.escape(id)}"]`
      )
      return el?.getBoundingClientRect() ?? new DOMRect()
    }
  })

  // All wall-clock reads/writes use the local (OS) timezone.
  const valueDate = new Date(value.dateISO)
  const selectedDate = Number.isNaN(valueDate.getTime()) ? undefined : valueDate
  const parts = selectedDate
    ? {
        y: selectedDate.getFullYear(),
        mo: selectedDate.getMonth() + 1,
        d: selectedDate.getDate(),
        h: selectedDate.getHours(),
        mi: selectedDate.getMinutes()
      }
    : { y: 1970, mo: 1, d: 1, h: 9, mi: 0 }

  // Uncontrolled + keyed so it resets to the canonical text whenever the date
  // changes externally (calendar pick, etc.) without a resync effect; free
  // typing is read on blur/Enter.
  const dateKey = `${parts.y}-${parts.mo}-${parts.d}`
  const dateText = `${pad(parts.d)}/${pad(parts.mo)}/${parts.y}`

  function emitYMDHM(
    y: number,
    mo: number,
    d: number,
    h: number,
    mi: number,
    hasTime: boolean
  ): void {
    const dateISO = new Date(y, mo - 1, d, h, mi, 0, 0).toISOString()
    onChange({ ...value, dateISO, hasTime })
  }

  function handleDateSelect(date: Date | undefined): void {
    if (!date) return
    emitYMDHM(
      date.getFullYear(),
      date.getMonth() + 1,
      date.getDate(),
      parts.h,
      parts.mi,
      value.hasTime
    )
  }

  function commitDateText(raw: string): void {
    const parsed = tryParseDateInput(raw)
    if (!parsed) return
    emitYMDHM(parsed.y, parsed.mo, parsed.d, parts.h, parts.mi, value.hasTime)
  }

  function handleTimeChange(raw: string): void {
    const [h, mi] = raw.split(':').map(Number)
    if (Number.isNaN(h) || Number.isNaN(mi)) return
    emitYMDHM(parts.y, parts.mo, parts.d, h, mi, true)
  }

  function handleToggleTime(checked: boolean): void {
    const valid = remindOptions(checked).some((o) => o.value === value.remind)
    onChange({ ...value, hasTime: checked, remind: valid ? value.remind : 'at' })
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        align="start"
        className="w-[250px] max-h-[520px] overflow-y-auto p-2"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex items-center gap-2">
          <Input
            key={dateKey}
            aria-label={t('dateMention.dateInput')}
            defaultValue={dateText}
            onBlur={(e) => commitDateText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitDateText(e.currentTarget.value)
            }}
            className="h-7 flex-1"
          />
          {value.hasTime && (
            <Input
              aria-label={t('dateMention.time')}
              type="time"
              value={`${pad(parts.h)}:${pad(parts.mi)}`}
              onChange={(e) => handleTimeChange(e.target.value)}
              className="h-7 w-24"
            />
          )}
        </div>

        <DatePickerCalendar
          selected={selectedDate}
          onSelect={handleDateSelect}
          className="pt-1 pb-1"
        />

        <div className="mt-1 border-t pt-0.5">
          <RowSelect
            label={t('dateMention.dateFormat')}
            ariaLabel={t('dateMention.dateFormat')}
            value={value.dateFormat}
            options={DATE_FORMAT_OPTIONS}
            onSelect={(dateFormat) => onChange({ ...value, dateFormat })}
          />

          <div className="flex items-center justify-between py-0.5">
            <Label htmlFor="date-mention-include-time" className="text-sm">
              {t('dateMention.includeTime')}
            </Label>
            <Switch
              id="date-mention-include-time"
              aria-label={t('dateMention.includeTime')}
              checked={value.hasTime}
              onCheckedChange={handleToggleTime}
            />
          </div>

          {value.hasTime && (
            <RowSelect
              label={t('dateMention.timeFormat')}
              ariaLabel={t('dateMention.timeFormat')}
              value={value.timeFormat}
              options={timeFormatOptions(clockFormat)}
              onSelect={(timeFormat) => onChange({ ...value, timeFormat })}
            />
          )}

          <RowSelect
            label={t('dateMention.remind')}
            ariaLabel={t('dateMention.remind')}
            value={value.remind}
            options={remindOptions(value.hasTime)}
            onSelect={(remind) => onChange({ ...value, remind })}
          />
        </div>

        <div className="mt-0.5 border-t pt-0.5">
          <button
            type="button"
            onClick={onClear}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-1 py-1 text-sm text-destructive hover:bg-accent'
            )}
          >
            <Trash2 className="h-4 w-4" />
            {t('dateMention.clear')}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
