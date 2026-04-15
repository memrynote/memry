import * as React from 'react'
import { useState } from 'react'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { Bell, Calendar, Clock, ChevronRight } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Picker } from '@/components/ui/picker'
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

export interface ReminderPickerProps {
  onSelect: (date: Date, title?: string, note?: string) => void
  presetType?: 'standard' | 'journal'
  variant?: 'default' | 'highlight'
  trigger?: React.ReactNode
  size?: 'sm' | 'md' | 'lg'
  showNote?: boolean
  showNoteField?: boolean
  disabled?: boolean
  isLoading?: boolean
  className?: string
}

type PickerMode = 'presets' | 'custom'

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
  const {
    settings: { clockFormat }
  } = useGeneralSettings()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<PickerMode>('presets')
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined)
  const [selectedTime, setSelectedTime] = useState('09:00')
  const [note, setNote] = useState('')

  const presets = presetType === 'journal' ? journalPresets : standardPresets
  const shouldShowNote = showNote || showNoteField

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
    if (!isOpen) resetState()
  }

  const handleValueChange = (id: string): void => {
    if (id === 'pick-custom') {
      setMode('custom')
      return
    }
    const preset = presets.find((p) => p.id === id)
    if (preset) handlePresetSelect(preset)
  }

  const sizeClasses = {
    sm: 'h-7 px-2 text-xs',
    md: 'h-8 px-3 text-sm',
    lg: 'h-10 px-4'
  }

  return (
    <Picker
      value={null}
      onValueChange={handleValueChange}
      open={open}
      onOpenChange={handleOpenChange}
      closeOnSelect={false}
    >
      <Picker.Trigger asChild>
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
      </Picker.Trigger>

      <Picker.Content className="w-80" align="start">
        {mode === 'presets' ? (
          <>
            <Picker.List>
              <Picker.Section label="Remind me">
                {presets.map((preset) => (
                  <Picker.Item
                    key={preset.id}
                    value={preset.id}
                    label={preset.label}
                    trailing={
                      preset.description ? (
                        <span className="text-[11px] text-muted-foreground/70">
                          {preset.description}
                        </span>
                      ) : undefined
                    }
                  />
                ))}
              </Picker.Section>
              <Picker.Separator />
              <Picker.Item
                value="pick-custom"
                label="Pick date & time"
                icon={<Calendar className="size-4" />}
                trailing={<ChevronRight className="size-4 text-muted-foreground" />}
              />
            </Picker.List>

            {shouldShowNote && (
              <>
                <Picker.Separator />
                <div className="px-3 py-2">
                  <Textarea
                    placeholder="Add a note (optional)"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    className="h-16 resize-none text-sm"
                  />
                </div>
              </>
            )}
          </>
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
                    })(),
                    clockFormat
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
      </Picker.Content>
    </Picker>
  )
}

export { standardPresets, journalPresets } from './reminder-presets'
