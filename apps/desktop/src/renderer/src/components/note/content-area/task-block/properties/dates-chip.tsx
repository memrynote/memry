import { useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Calendar } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { formatDateShort, formatDueDate, formatTime } from '@/lib/task-utils'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DatePickerContent } from '@/components/tasks/date-picker-content'
import type { Task } from '@/data/task-model'
import { CHIP_POPOVER_CLASS, PropertyChip } from './property-chip'
import { shortcutLabelFor, type TaskPropertyOpenState } from './task-property-ids'

type DateSegment = 'start' | 'due'

interface DatesChipProps extends TaskPropertyOpenState {
  startDate: Date | null
  dueDate: Date | null
  dueTime: string | null
  isCompleted: boolean
  onChange: (updates: Partial<Task>) => void
}

/**
 * Start and due share one chip and one calendar: two date chips side by side
 * are noise. The chip reads "Sep 12", "Sep 5 →" or "Sep 5 → Sep 12"; a segment
 * on top of the picker says which of the two a click sets.
 */
export const DatesChip = ({
  startDate,
  dueDate,
  dueTime,
  isCompleted,
  onChange,
  open,
  onOpenChange
}: DatesChipProps): React.JSX.Element | null => {
  const { t, i18n } = useT('tasks')
  const {
    settings: { clockFormat }
  } = useGeneralSettings()

  const isOpen = open === 'due' || open === 'start'
  if (!startDate && !dueDate && !isOpen) return null

  const dueLabel = dueDate
    ? dueTime
      ? `${formatDateShort(dueDate)}, ${formatTime(dueTime, clockFormat)}`
      : formatDateShort(dueDate)
    : null
  const startLabel = startDate ? formatDateShort(startDate) : null
  // The arrow reads start-to-due, so it points the way the line reads.
  const arrow = i18n.dir() === 'rtl' ? '←' : '→'
  const label =
    startLabel && dueLabel
      ? `${startLabel} ${arrow} ${dueLabel}`
      : startLabel
        ? `${startLabel} ${arrow}`
        : (dueLabel ?? t('inlineProperties.dates'))
  const isOverdue = !isCompleted && formatDueDate(dueDate, dueTime)?.status === 'overdue'

  // A click opens on whichever date is set; with both or neither, due.
  const clickSegment: DateSegment = !dueDate && startDate ? 'start' : 'due'

  return (
    <Popover
      open={isOpen}
      onOpenChange={(next) => onOpenChange(next ? clickSegment : (open ?? clickSegment), next)}
    >
      <PopoverTrigger asChild>
        <PropertyChip
          icon={<Calendar size={12} className="shrink-0" aria-hidden="true" />}
          tone={isOverdue ? 'overdue' : 'default'}
          aria-label={t('inlineProperties.datesAria', { value: label })}
          title={`${t('inlineProperties.dates')} · ${shortcutLabelFor('due')}`}
        >
          {label}
        </PropertyChip>
      </PopoverTrigger>
      <PopoverContent className={CHIP_POPOVER_CLASS} align="start">
        <DatesPicker
          initialSegment={open === 'start' ? 'start' : 'due'}
          startDate={startDate}
          dueDate={dueDate}
          dueTime={dueTime}
          onChange={onChange}
          onDone={() => onOpenChange(open ?? 'due', false)}
        />
      </PopoverContent>
    </Popover>
  )
}

interface DatesPickerProps {
  initialSegment: DateSegment
  startDate: Date | null
  dueDate: Date | null
  dueTime: string | null
  onChange: (updates: Partial<Task>) => void
  onDone: () => void
}

// Mounted per open, so the segment starts wherever the chip was opened from.
const DatesPicker = ({
  initialSegment,
  startDate,
  dueDate,
  dueTime,
  onChange,
  onDone
}: DatesPickerProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const [segment, setSegment] = useState<DateSegment>(initialSegment)
  const selected = segment === 'due' ? dueDate : startDate

  const handleSelect = (date: Date | null): void => {
    if (segment === 'due') {
      // A time with no day is unreachable in every view, so clearing the due
      // date takes the time with it.
      onChange(date ? { dueDate: date } : { dueDate: null, dueTime: null })
    } else {
      onChange({ startDate: date })
    }
    onDone()
  }

  const segments: { id: DateSegment; label: string }[] = [
    { id: 'start', label: t('inlineProperties.start') },
    { id: 'due', label: t('inlineProperties.due') }
  ]

  return (
    <div className="flex min-h-0 flex-col">
      <div
        role="radiogroup"
        aria-label={t('inlineProperties.dates')}
        className="m-1 flex shrink-0 gap-0.5 rounded-md bg-surface-active/60 p-0.5"
      >
        {segments.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={segment === item.id}
            onClick={() => setSegment(item.id)}
            className={cn(
              'h-6 flex-1 rounded-[5px] text-[12px] leading-4 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-text-tertiary',
              segment === item.id
                ? 'bg-popover font-medium text-foreground shadow-xs'
                : 'text-text-secondary hover:text-foreground'
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <DatePickerContent
        key={segment}
        selected={selected}
        onSelect={handleSelect}
        showRemoveDate={!!selected}
        time={segment === 'due' ? dueTime : undefined}
        onTimeChange={segment === 'due' ? (time) => onChange({ dueTime: time }) : undefined}
      />
    </div>
  )
}
