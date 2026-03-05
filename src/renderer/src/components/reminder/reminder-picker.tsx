/**
 * Reminder Picker Component
 *
 * A dropdown/popover for selecting reminder times with presets
 * and custom date/time picker option.
 *
 * @module components/reminder/reminder-picker
 */

import * as React from 'react'
import { useState } from 'react'
import { Bell, Calendar, Clock, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DatePickerCalendar } from '@/components/tasks/date-picker-calendar'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  type ReminderPreset,
  standardPresets,
  journalPresets,
  formatReminderDate
} from './reminder-presets'

// ============================================================================
// Types
// ============================================================================

export interface ReminderPickerProps {
  /** Called when a reminder time is selected */
  onSelect: (date: Date, title?: string, note?: string) => void
  /** Type of presets to show */
  presetType?: 'standard' | 'journal'
  /** Variant - affects layout */
  variant?: 'default' | 'highlight'
  /** Custom trigger button (optional) */
  trigger?: React.ReactNode
  /** Size variant */
  size?: 'sm' | 'md' | 'lg'
  /** Whether to show the note field */
  showNote?: boolean
  /** Whether to show the note field (alias for showNote) */
  showNoteField?: boolean
  /** Disabled state */
  disabled?: boolean
  /** Loading state */
  isLoading?: boolean
  /** Class name for the trigger */
  className?: string
}

type PickerMode = 'presets' | 'custom'

// ============================================================================
// Component
// ============================================================================

export function ReminderPicker({
  onSelect,
  presetType = 'standard',
  variant: _variant = 'default',
  trigger,
  size = 'md',
  showNote = false,
  showNoteField = false,
  disabled = false,
  isLoading = false,
  className
}: ReminderPickerProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<PickerMode>('presets')
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined)
  const [selectedTime, setSelectedTime] = useState('09:00')
  const [note, setNote] = useState('')

  const presets = presetType === 'journal' ? journalPresets : standardPresets
  const shouldShowNote = showNote || showNoteField
  // Note: variant is available for future styling variations

  const handlePresetSelect = (preset: ReminderPreset): void => {
    const date = preset.getDate()
    onSelect(date, undefined, note || undefined)
    setOpen(false)
    resetState()
  }

  const handleCustomSubmit = (): void => {
    if (!selectedDate) return

    const [hours, minutes] = selectedTime.split(':').map(Number)
    const date = new Date(selectedDate)
    date.setHours(hours, minutes, 0, 0)

    onSelect(date, undefined, note || undefined)
    setOpen(false)
    resetState()
  }

  const resetState = (): void => {
    setMode('presets')
    setSelectedDate(undefined)
    setSelectedTime('09:00')
    setNote('')
  }

  const handleOpenChange = (isOpen: boolean): void => {
    setOpen(isOpen)
    if (!isOpen) {
      resetState()
    }
  }

  const sizeClasses = {
    sm: 'h-7 px-2 text-xs',
    md: 'h-8 px-3 text-sm',
    lg: 'h-10 px-4'
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        {trigger || (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            className={cn(sizeClasses[size], 'gap-1.5', className)}
          >
            <Bell className="h-4 w-4" />
            <span>Remind</span>
          </Button>
        )}
      </PopoverTrigger>

      <PopoverContent className="w-80 p-0" align="start">
        {mode === 'presets' ? (
          <div className="p-2">
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Remind me</div>

            <div className="space-y-0.5">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => handlePresetSelect(preset)}
                  className="flex w-full items-center justify-between rounded-sm px-2 py-2 text-sm hover:bg-accent"
                >
                  <span>{preset.label}</span>
                  {preset.description && (
                    <span className="text-xs text-muted-foreground">{preset.description}</span>
                  )}
                </button>
              ))}
            </div>

            <div className="my-2 h-px bg-border" />

            <button
              onClick={() => setMode('custom')}
              className="flex w-full items-center justify-between rounded-sm px-2 py-2 text-sm hover:bg-accent"
            >
              <span className="flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                Pick date & time
              </span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </button>

            {shouldShowNote && (
              <>
                <div className="my-2 h-px bg-border" />
                <div className="px-2 py-1">
                  <Textarea
                    placeholder="Add a note (optional)"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    className="h-16 resize-none text-sm"
                  />
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="p-2">
            <button
              onClick={() => setMode('presets')}
              className="mb-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className="h-3 w-3 rotate-180" />
              Back to presets
            </button>

            <DatePickerCalendar
              selected={selectedDate}
              onSelect={(d) => setSelectedDate(d)}
              disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0))}
              className="rounded-md border p-2"
            />

            <div className="mt-3 space-y-3 px-1">
              <div className="flex items-center gap-2">
                <Label htmlFor="reminder-time" className="flex items-center gap-1.5 text-sm">
                  <Clock className="h-4 w-4" />
                  Time
                </Label>
                <Input
                  id="reminder-time"
                  type="time"
                  value={selectedTime}
                  onChange={(e) => setSelectedTime(e.target.value)}
                  className="h-8 w-28"
                />
              </div>

              {shouldShowNote && (
                <div>
                  <Label htmlFor="reminder-note" className="text-sm">
                    Note (optional)
                  </Label>
                  <Textarea
                    id="reminder-note"
                    placeholder="Why are you setting this reminder?"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    className="mt-1.5 h-16 resize-none text-sm"
                  />
                </div>
              )}

              {selectedDate && (
                <div className="text-xs text-muted-foreground">
                  {formatReminderDate(
                    (() => {
                      const [hours, minutes] = selectedTime.split(':').map(Number)
                      const date = new Date(selectedDate)
                      date.setHours(hours, minutes, 0, 0)
                      return date
                    })()
                  )}
                </div>
              )}

              <Button
                onClick={handleCustomSubmit}
                disabled={!selectedDate || isLoading}
                className="w-full"
                size="sm"
              >
                {isLoading ? 'Setting...' : 'Set Reminder'}
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ============================================================================
// Exports
// ============================================================================

export { standardPresets, journalPresets } from './reminder-presets'
