import { useState, useMemo, useCallback } from 'react'
import { CalendarIcon } from 'lucide-react'
import { format } from 'date-fns'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'
import { cn } from '@/lib/utils'
import {
  calculateNextOccurrences,
  getOrdinalSuffix,
  DAY_NAMES,
  SHORT_DAY_NAMES,
  ORDINALS,
  createDefaultRepeatConfig
} from '@/lib/repeat-utils'
import { formatDateShort } from '@/lib/task-utils'
import type { RepeatConfig, RepeatFrequency, RepeatEndType, MonthlyType } from '@/data/sample-tasks'

// ============================================================================
// TYPES
// ============================================================================

interface CustomRepeatDialogProps {
  isOpen: boolean
  onClose: () => void
  onSave: (config: RepeatConfig) => void
  initialConfig?: RepeatConfig | null
  dueDate?: Date | null
}

// ============================================================================
// DAY OF WEEK PICKER SUB-COMPONENT
// ============================================================================

interface DayOfWeekPickerProps {
  selectedDays: number[]
  onChange: (days: number[]) => void
}

const DayOfWeekPicker = ({ selectedDays, onChange }: DayOfWeekPickerProps): React.JSX.Element => {
  const handleToggleDay = (day: number): void => {
    if (selectedDays.includes(day)) {
      // Don't allow deselecting the last day
      if (selectedDays.length > 1) {
        onChange(selectedDays.filter((d) => d !== day))
      }
    } else {
      onChange([...selectedDays, day])
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        On these days
      </Label>
      <div className="flex gap-1">
        {SHORT_DAY_NAMES.map((name, index) => (
          <button
            key={index}
            type="button"
            onClick={() => handleToggleDay(index)}
            className={cn(
              'flex size-9 items-center justify-center rounded-full text-sm font-medium transition-colors',
              'border focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
              selectedDays.includes(index)
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
            aria-label={`${DAY_NAMES[index]}${selectedDays.includes(index) ? ', selected' : ''}`}
            aria-pressed={selectedDays.includes(index)}
          >
            {name.charAt(0)}
          </button>
        ))}
      </div>
    </div>
  )
}

// ============================================================================
// MONTHLY REPEAT OPTIONS SUB-COMPONENT
// ============================================================================

interface MonthlyRepeatOptionsProps {
  monthlyType: MonthlyType
  dayOfMonth: number
  weekOfMonth: number
  dayOfWeekForMonth: number
  onChange: (updates: {
    monthlyType?: MonthlyType
    dayOfMonth?: number
    weekOfMonth?: number
    dayOfWeekForMonth?: number
  }) => void
}

const MonthlyRepeatOptions = ({
  monthlyType,
  dayOfMonth,
  weekOfMonth,
  dayOfWeekForMonth,
  onChange
}: MonthlyRepeatOptionsProps): React.JSX.Element => {
  return (
    <div className="flex flex-col gap-3">
      <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Repeat on
      </Label>

      {/* Day of month option */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="radio"
          name="monthlyType"
          checked={monthlyType === 'dayOfMonth'}
          onChange={() => onChange({ monthlyType: 'dayOfMonth' })}
          className="size-4 accent-primary"
        />
        <span className="text-sm">Day</span>
        <Select
          value={dayOfMonth.toString()}
          onValueChange={(val) => onChange({ dayOfMonth: parseInt(val, 10) })}
          disabled={monthlyType !== 'dayOfMonth'}
        >
          <SelectTrigger className="w-[80px] h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
              <SelectItem key={day} value={day.toString()}>
                {day}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">of the month</span>
      </label>

      {/* Week pattern option */}
      <label className="flex items-center gap-2 cursor-pointer flex-wrap">
        <input
          type="radio"
          name="monthlyType"
          checked={monthlyType === 'weekPattern'}
          onChange={() => onChange({ monthlyType: 'weekPattern' })}
          className="size-4 accent-primary"
        />
        <span className="text-sm">The</span>
        <Select
          value={weekOfMonth.toString()}
          onValueChange={(val) => onChange({ weekOfMonth: parseInt(val, 10) })}
          disabled={monthlyType !== 'weekPattern'}
        >
          <SelectTrigger className="w-[100px] h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[1, 2, 3, 4, 5].map((week) => (
              <SelectItem key={week} value={week.toString()}>
                {ORDINALS[week]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={dayOfWeekForMonth.toString()}
          onValueChange={(val) => onChange({ dayOfWeekForMonth: parseInt(val, 10) })}
          disabled={monthlyType !== 'weekPattern'}
        >
          <SelectTrigger className="w-[120px] h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DAY_NAMES.map((name, index) => (
              <SelectItem key={index} value={index.toString()}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">of the month</span>
      </label>
    </div>
  )
}

// ============================================================================
// REPEAT END OPTIONS SUB-COMPONENT
// ============================================================================

interface RepeatEndOptionsProps {
  endType: RepeatEndType
  endDate: Date | null
  endCount: number
  onChange: (updates: { endType?: RepeatEndType; endDate?: Date | null; endCount?: number }) => void
}

const RepeatEndOptions = ({
  endType,
  endDate,
  endCount,
  onChange
}: RepeatEndOptionsProps): React.JSX.Element => {
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false)

  return (
    <div className="flex flex-col gap-3">
      <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Ends
      </Label>

      {/* Never */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="radio"
          name="endType"
          checked={endType === 'never'}
          onChange={() => onChange({ endType: 'never' })}
          className="size-4 accent-primary"
        />
        <span className="text-sm">Never</span>
      </label>

      {/* On date */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="radio"
          name="endType"
          checked={endType === 'date'}
          onChange={() => onChange({ endType: 'date' })}
          className="size-4 accent-primary"
        />
        <span className="text-sm">On date</span>
        <Popover open={isDatePickerOpen} onOpenChange={setIsDatePickerOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={endType !== 'date'}
              className={cn(
                'w-[140px] justify-start text-left font-normal',
                !endDate && 'text-muted-foreground'
              )}
            >
              <CalendarIcon className="mr-2 size-4" />
              {endDate ? format(endDate, 'MMM d, yyyy') : 'Pick a date'}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={endDate || undefined}
              onSelect={(date) => {
                onChange({ endDate: date || null })
                setIsDatePickerOpen(false)
              }}
              disabled={(date) => date < new Date()}
              initialFocus
            />
          </PopoverContent>
        </Popover>
      </label>

      {/* After count */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="radio"
          name="endType"
          checked={endType === 'count'}
          onChange={() => onChange({ endType: 'count' })}
          className="size-4 accent-primary"
        />
        <span className="text-sm">After</span>
        <Input
          type="number"
          min={1}
          max={999}
          value={endCount}
          onChange={(e) => onChange({ endCount: Math.max(1, parseInt(e.target.value, 10) || 1) })}
          disabled={endType !== 'count'}
          className="w-[70px] h-8"
        />
        <span className="text-sm text-muted-foreground">occurrences</span>
      </label>
    </div>
  )
}

// ============================================================================
// REPEAT PREVIEW SUB-COMPONENT
// ============================================================================

interface RepeatPreviewProps {
  config: RepeatConfig
  startDate: Date
}

const RepeatPreview = ({ config, startDate }: RepeatPreviewProps): React.JSX.Element => {
  const occurrences = useMemo(() => {
    return calculateNextOccurrences(startDate, config, 5)
  }, [config, startDate])

  const previewHeader = useMemo(() => {
    if (config.endType === 'count' && config.endCount) {
      return `${config.endCount} occurrences:`
    }
    if (config.endType === 'date' && config.endDate) {
      return `Occurrences until ${formatDateShort(config.endDate)}:`
    }
    return 'Next occurrences:'
  }, [config])

  return (
    <div className="flex flex-col gap-2">
      <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Preview
      </Label>
      <p className="text-xs text-muted-foreground">{previewHeader}</p>
      <ul className="flex flex-col gap-1 text-sm">
        {occurrences.map((date, index) => (
          <li key={index} className="flex items-center gap-2">
            <span className="text-muted-foreground">•</span>
            <span>
              {format(date, 'EEE, MMM d, yyyy')}
              {config.endType === 'count' && config.endCount && (
                <span className="text-muted-foreground ml-2">
                  ({index + 1} of {config.endCount})
                </span>
              )}
            </span>
          </li>
        ))}
        {occurrences.length >= 5 && config.endType === 'never' && (
          <li className="text-muted-foreground text-xs">... and more</li>
        )}
      </ul>
    </div>
  )
}

// ============================================================================
// CUSTOM REPEAT DIALOG COMPONENT
// ============================================================================

// Inner component that gets reset via key prop
const CustomRepeatDialogInner = ({
  onClose,
  onSave,
  initialConfig,
  effectiveDueDate
}: {
  onClose: () => void
  onSave: (config: RepeatConfig) => void
  initialConfig?: RepeatConfig | null
  effectiveDueDate: Date
}): React.JSX.Element => {
  // Compute initial state from props - no useEffect needed!
  const getInitialState = useCallback(() => {
    if (initialConfig) {
      return {
        frequency: initialConfig.frequency,
        interval: initialConfig.interval,
        daysOfWeek: initialConfig.daysOfWeek || [effectiveDueDate.getDay()],
        monthlyType: initialConfig.monthlyType || ('dayOfMonth' as MonthlyType),
        dayOfMonth: initialConfig.dayOfMonth || effectiveDueDate.getDate(),
        weekOfMonth: initialConfig.weekOfMonth || Math.ceil(effectiveDueDate.getDate() / 7),
        dayOfWeekForMonth: initialConfig.dayOfWeekForMonth ?? effectiveDueDate.getDay(),
        endType: initialConfig.endType,
        endDate: initialConfig.endDate || null,
        endCount: initialConfig.endCount || 10
      }
    }

    const defaultConfig = createDefaultRepeatConfig('weekly', effectiveDueDate)
    return {
      frequency: defaultConfig.frequency,
      interval: defaultConfig.interval,
      daysOfWeek: defaultConfig.daysOfWeek || [effectiveDueDate.getDay()],
      monthlyType: 'dayOfMonth' as MonthlyType,
      dayOfMonth: effectiveDueDate.getDate(),
      weekOfMonth: Math.ceil(effectiveDueDate.getDate() / 7),
      dayOfWeekForMonth: effectiveDueDate.getDay(),
      endType: 'never' as RepeatEndType,
      endDate: null,
      endCount: 10
    }
  }, [initialConfig, effectiveDueDate])

  const initialState = useMemo(() => getInitialState(), [getInitialState])

  // Initialize form state directly from computed initial state
  const [frequency, setFrequency] = useState<RepeatFrequency>(initialState.frequency)
  const [interval, setInterval] = useState(initialState.interval)
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(initialState.daysOfWeek)
  const [monthlyType, setMonthlyType] = useState<MonthlyType>(initialState.monthlyType)
  const [dayOfMonth, setDayOfMonth] = useState(initialState.dayOfMonth)
  const [weekOfMonth, setWeekOfMonth] = useState(initialState.weekOfMonth)
  const [dayOfWeekForMonth, setDayOfWeekForMonth] = useState(initialState.dayOfWeekForMonth)
  const [endType, setEndType] = useState<RepeatEndType>(initialState.endType)
  const [endDate, setEndDate] = useState<Date | null>(initialState.endDate)
  const [endCount, setEndCount] = useState(initialState.endCount)

  // Build current config for preview
  const currentConfig = useMemo(
    (): RepeatConfig => ({
      frequency,
      interval,
      daysOfWeek: frequency === 'weekly' ? daysOfWeek : undefined,
      monthlyType: frequency === 'monthly' ? monthlyType : undefined,
      dayOfMonth: frequency === 'monthly' && monthlyType === 'dayOfMonth' ? dayOfMonth : undefined,
      weekOfMonth:
        frequency === 'monthly' && monthlyType === 'weekPattern' ? weekOfMonth : undefined,
      dayOfWeekForMonth:
        frequency === 'monthly' && monthlyType === 'weekPattern' ? dayOfWeekForMonth : undefined,
      endType,
      endDate: endType === 'date' ? endDate : undefined,
      endCount: endType === 'count' ? endCount : undefined,
      completedCount: initialConfig?.completedCount || 0,
      createdAt: initialConfig?.createdAt || new Date()
    }),
    [
      frequency,
      interval,
      daysOfWeek,
      monthlyType,
      dayOfMonth,
      weekOfMonth,
      dayOfWeekForMonth,
      endType,
      endDate,
      endCount,
      initialConfig
    ]
  )

  const handleSave = useCallback((): void => {
    onSave(currentConfig)
    onClose()
  }, [currentConfig, onSave, onClose])

  const handleMonthlyChange = useCallback(
    (updates: {
      monthlyType?: MonthlyType
      dayOfMonth?: number
      weekOfMonth?: number
      dayOfWeekForMonth?: number
    }): void => {
      if (updates.monthlyType !== undefined) setMonthlyType(updates.monthlyType)
      if (updates.dayOfMonth !== undefined) setDayOfMonth(updates.dayOfMonth)
      if (updates.weekOfMonth !== undefined) setWeekOfMonth(updates.weekOfMonth)
      if (updates.dayOfWeekForMonth !== undefined) setDayOfWeekForMonth(updates.dayOfWeekForMonth)
    },
    []
  )

  const handleEndChange = useCallback(
    (updates: { endType?: RepeatEndType; endDate?: Date | null; endCount?: number }): void => {
      if (updates.endType !== undefined) setEndType(updates.endType)
      if (updates.endDate !== undefined) setEndDate(updates.endDate)
      if (updates.endCount !== undefined) setEndCount(updates.endCount)
    },
    []
  )

  return (
    <div className="flex flex-col gap-6 py-4">
      {/* Frequency selector */}
      <div className="flex flex-col gap-2">
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Frequency
        </Label>
        <div className="flex items-center gap-2">
          <span className="text-sm">Repeat every</span>
          <Input
            type="number"
            min={1}
            max={99}
            value={interval}
            onChange={(e) => setInterval(Math.max(1, parseInt(e.target.value, 10) || 1))}
            className="w-[60px] h-8"
          />
          <Select value={frequency} onValueChange={(val) => setFrequency(val as RepeatFrequency)}>
            <SelectTrigger className="w-[100px] h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">day{interval > 1 ? 's' : ''}</SelectItem>
              <SelectItem value="weekly">week{interval > 1 ? 's' : ''}</SelectItem>
              <SelectItem value="monthly">month{interval > 1 ? 's' : ''}</SelectItem>
              <SelectItem value="yearly">year{interval > 1 ? 's' : ''}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Day of week picker (for weekly) */}
      {frequency === 'weekly' && (
        <DayOfWeekPicker selectedDays={daysOfWeek} onChange={setDaysOfWeek} />
      )}

      {/* Monthly options */}
      {frequency === 'monthly' && (
        <MonthlyRepeatOptions
          monthlyType={monthlyType}
          dayOfMonth={dayOfMonth}
          weekOfMonth={weekOfMonth}
          dayOfWeekForMonth={dayOfWeekForMonth}
          onChange={handleMonthlyChange}
        />
      )}

      {/* End options */}
      <RepeatEndOptions
        endType={endType}
        endDate={endDate}
        endCount={endCount}
        onChange={handleEndChange}
      />

      {/* Separator */}
      <div className="h-px bg-border" />

      {/* Preview */}
      <RepeatPreview config={currentConfig} startDate={effectiveDueDate} />

      {/* Footer buttons */}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={handleSave}>Save</Button>
      </DialogFooter>
    </div>
  )
}

// Outer wrapper component that handles dialog state with key-based reset
export const CustomRepeatDialog = ({
  isOpen,
  onClose,
  onSave,
  initialConfig,
  dueDate
}: CustomRepeatDialogProps): React.JSX.Element => {
  const effectiveDueDate = dueDate || new Date()

  // Create a stable key that changes when dialog opens/closes or config changes
  // This causes React to unmount/remount the inner component, resetting all state
  const dialogKey = useMemo(() => {
    if (!isOpen) return 'closed'
    const configId = initialConfig ? JSON.stringify(initialConfig) : 'new'
    const dateId = effectiveDueDate.getTime()
    return `${configId}-${dateId}`
  }, [isOpen, initialConfig, effectiveDueDate])

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Custom Repeat</DialogTitle>
        </DialogHeader>
        {isOpen && (
          <CustomRepeatDialogInner
            key={dialogKey}
            onClose={onClose}
            onSave={onSave}
            initialConfig={initialConfig}
            effectiveDueDate={effectiveDueDate}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

export default CustomRepeatDialog
