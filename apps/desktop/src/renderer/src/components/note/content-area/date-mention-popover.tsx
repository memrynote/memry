import { useEffect, useMemo, useRef } from 'react'
import type { DateMentionLead } from '@memry/shared/date-mention'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { DatePickerCalendar } from '@/components/tasks/date-picker-calendar'
import { Clock } from '@/lib/icons'

export interface DateMentionValue {
  dateISO: string
  hasTime: boolean
  remind: boolean
  lead: DateMentionLead
}

interface DateMentionPopoverProps {
  open: boolean
  anchorId: string | null
  value: DateMentionValue
  onChange: (next: DateMentionValue) => void
  onClose: () => void
}

// NOTE: labels hardcoded in English for now (annotated with TODO(i18n) at the
// JSX sites). The surrounding note editor strings live in the `notes`
// namespace; wiring real keys across 32 locale files is deferred follow-up.
const LEAD_OPTIONS: ReadonlyArray<{ value: DateMentionLead; label: string }> = [
  { value: 'at', label: 'At time of event' },
  { value: '5m', label: '5 minutes before' },
  { value: '1h', label: '1 hour before' },
  { value: '1d', label: '1 day before' }
]

function toTimeInputValue(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

export function DateMentionPopover({
  open,
  anchorId,
  value,
  onChange,
  onClose
}: DateMentionPopoverProps): React.JSX.Element {
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

  const selectedDate = useMemo(() => {
    const d = new Date(value.dateISO)
    return Number.isNaN(d.getTime()) ? undefined : d
  }, [value.dateISO])

  const timeValue = selectedDate ? toTimeInputValue(selectedDate) : '09:00'

  function emitDate(next: Date, hasTime: boolean): void {
    onChange({ ...value, dateISO: next.toISOString(), hasTime })
  }

  function handleDateSelect(date: Date | undefined): void {
    if (!date) return
    let base = selectedDate ?? new Date(value.dateISO)
    if (Number.isNaN(base.getTime())) base = new Date()
    const next = new Date(date)
    next.setHours(base.getHours(), base.getMinutes(), 0, 0)
    emitDate(next, value.hasTime)
  }

  function handleTimeChange(raw: string): void {
    const [hours, minutes] = raw.split(':').map(Number)
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return
    const next = selectedDate ? new Date(selectedDate) : new Date(value.dateISO)
    if (Number.isNaN(next.getTime())) next.setTime(Date.now())
    next.setHours(hours, minutes, 0, 0)
    emitDate(next, true)
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
        className="w-80 p-3"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DatePickerCalendar
          selected={selectedDate}
          onSelect={handleDateSelect}
          className="rounded-md border p-2"
        />

        <div className="mt-3 flex items-center gap-2">
          <Label htmlFor="date-mention-time" className="flex items-center gap-1.5 text-sm">
            <Clock className="h-4 w-4" />
            {/* TODO(i18n): wrap Time in t() */}
            <span>Time</span>
          </Label>
          <Input
            id="date-mention-time"
            type="time"
            value={timeValue}
            onChange={(e) => handleTimeChange(e.target.value)}
            className="h-8 w-28"
          />
        </div>

        <div className="mt-3 flex items-center justify-between">
          <Label htmlFor="date-mention-remind" className="text-sm">
            {/* TODO(i18n): wrap Remind in t() */}
            Remind me
          </Label>
          <Switch
            id="date-mention-remind"
            checked={value.remind}
            onCheckedChange={(checked) => onChange({ ...value, remind: checked })}
          />
        </div>

        <div className="mt-3">
          <Select
            value={value.lead}
            onValueChange={(lead) => onChange({ ...value, lead: lead as DateMentionLead })}
            disabled={!value.remind}
          >
            {/* TODO(i18n): wrap Reminder-lead-time in t() */}
            <SelectTrigger className="h-8" aria-label="Reminder lead time">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEAD_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </PopoverContent>
    </Popover>
  )
}
