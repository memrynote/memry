import * as React from 'react'
import { useState } from 'react'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { Bell, Calendar, Clock, ChevronRight, Pencil, Trash2 } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Picker } from '@/components/ui/picker'
import { DatePickerCalendar } from '@/components/tasks/date-picker-calendar'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { trackTelemetry } from '@/lib/telemetry'
import type { TelemetrySurface } from '@memry/contracts/telemetry-api'
import { useT } from '@memry/i18n/renderer'
import {
  type ReminderPreset,
  standardPresets,
  journalPresets,
  formatReminderDate
} from './reminder-presets'

/** Minimal shape of an existing reminder rendered in the management list. */
export interface ManagedReminder {
  id: string
  remindAt: string
  note?: string | null
  status?: string
}

export interface ReminderPickerProps {
  onSelect: (date: Date, title?: string, note?: string) => void
  presetType?: 'standard' | 'journal'
  trigger?: React.ReactNode
  size?: 'sm' | 'md' | 'lg'
  showNote?: boolean
  showNoteField?: boolean
  disabled?: boolean
  isLoading?: boolean
  className?: string
  /** Existing reminders to manage (opt-in). When provided, a list renders below the presets. */
  reminders?: ManagedReminder[]
  /** Edit an existing reminder's time/note. Required for the edit affordance. */
  onEdit?: (id: string, date: Date, note?: string) => void
  /** Delete an existing reminder by id. Required for the delete affordance. */
  onDelete?: (id: string) => void
  /**
   * Surface this picker was opened from. Supplying it turns on `reminder_created`
   * / `reminder_deleted` telemetry; leaving it out keeps the picker silent.
   *
   * The picker is the one place that knows whether a reminder time came from a
   * relative preset or from the custom date & time pane, so it is also where the
   * event is emitted — see components/reminder/reminder-picker.tsx in
   * apps/docs/src/architecture/observability.md.
   */
  telemetrySurface?: TelemetrySurface
}

type PickerMode = 'presets' | 'custom' | 'edit'

const SIZE_CLASSES = {
  sm: 'h-7 px-2 text-xs',
  md: 'h-8 px-3 text-sm',
  lg: 'h-10 px-4'
}

const CUSTOM_PICKER_TRAILING = <ChevronRight className="size-4 text-muted-foreground" />

export function ReminderPicker({
  onSelect,
  presetType = 'standard',
  trigger,
  size = 'md',
  showNote = false,
  showNoteField = false,
  disabled = false,
  isLoading = false,
  className,
  reminders,
  onEdit,
  onDelete,
  telemetrySurface
}: ReminderPickerProps): React.ReactElement {
  const { t: tPhaseF } = useT('inbox')
  const {
    settings: { clockFormat }
  } = useGeneralSettings()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<PickerMode>('presets')
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined)
  const [selectedTime, setSelectedTime] = useState('09:00')
  const [note, setNote] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)

  const presets = presetType === 'journal' ? journalPresets : standardPresets
  const shouldShowNote = showNote || showNoteField

  const buildSelectedDate = (): Date | null => {
    if (!selectedDate) return null
    const [hours, minutes] = selectedTime.split(':').map(Number)
    const date = new Date(selectedDate)
    date.setHours(hours, minutes, 0, 0)
    return date
  }

  /**
   * Nothing derived from the reminder itself ships: not its note, not its title,
   * not the target's id or name, not the time it is set for. `presetId` is one of
   * the fixed ids in reminder-presets.ts, so the dimension stays a bounded enum.
   */
  const trackReminderCreated = (origin: 'preset' | 'custom', presetId?: string): void => {
    if (!telemetrySurface) return
    void trackTelemetry('reminder_created', {
      surface: telemetrySurface,
      action: 'created',
      source: origin,
      dimensions: presetId ? { value: presetId } : undefined
    })
  }

  const handlePresetSelect = (preset: ReminderPreset): void => {
    const date = preset.getDate()
    onSelect(date, undefined, note || undefined)
    trackReminderCreated('preset', preset.id)
    setOpen(false)
    resetState()
  }

  const handleCustomSubmit = (): void => {
    const date = buildSelectedDate()
    if (!date) return

    onSelect(date, undefined, note || undefined)
    trackReminderCreated('custom')
    setOpen(false)
    resetState()
  }

  const startEdit = (reminder: ManagedReminder): void => {
    const date = new Date(reminder.remindAt)
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    setEditingId(reminder.id)
    setSelectedDate(date)
    setSelectedTime(`${hours}:${minutes}`)
    setNote(reminder.note ?? '')
    setMode('edit')
  }

  const handleEditSubmit = (): void => {
    const date = buildSelectedDate()
    if (!date || !editingId) return

    onEdit?.(editingId, date, note || undefined)
    setOpen(false)
    resetState()
  }

  const resetState = (): void => {
    setMode('presets')
    setSelectedDate(undefined)
    setSelectedTime('09:00')
    setNote('')
    setEditingId(null)
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

  const sizeClasses = SIZE_CLASSES

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
            <span>{tPhaseF('phaseF.componentsReminderReminderPicker.remind')}</span>
          </Button>
        )}
      </Picker.Trigger>

      <Picker.Content className="w-80" align="start">
        {mode === 'presets' ? (
          <>
            <Picker.List>
              <Picker.Section label={tPhaseF('phaseF.componentsReminderReminderPicker.remindMe')}>
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
                label={tPhaseF('phaseF.componentsReminderReminderPicker.pickDateTime')}
                icon={<Calendar className="size-4" />}
                trailing={CUSTOM_PICKER_TRAILING}
              />
            </Picker.List>

            {shouldShowNote && (
              <>
                <Picker.Separator />
                <div className="px-3 py-2">
                  <Textarea
                    placeholder={tPhaseF(
                      'phaseF.componentsReminderReminderPicker.addANoteOptional'
                    )}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    className="h-16 resize-none text-sm"
                  />
                </div>
              </>
            )}

            {reminders && reminders.length > 0 && onEdit && onDelete && (
              <>
                <Picker.Separator />
                <div className="px-1.5 py-1.5">
                  <div className="px-1.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                    {tPhaseF('phaseF.componentsReminderReminderPicker.set')} ({reminders.length})
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {reminders.map((reminder) => (
                      <div
                        key={reminder.id}
                        className="group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/50"
                      >
                        <Bell className="size-3.5 shrink-0 text-amber-500" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm">
                            {formatReminderDate(new Date(reminder.remindAt), clockFormat)}
                          </div>
                          {reminder.note && (
                            <div className="truncate text-[11px] text-muted-foreground">
                              {reminder.note}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          aria-label={tPhaseF(
                            'phaseF.componentsReminderReminderPicker.editReminder'
                          )}
                          onClick={() => startEdit(reminder)}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <Pencil className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={tPhaseF(
                            'phaseF.componentsReminderReminderPicker.deleteReminder'
                          )}
                          onClick={() => {
                            onDelete(reminder.id)
                            if (telemetrySurface) {
                              void trackTelemetry('reminder_deleted', {
                                surface: telemetrySurface,
                                action: 'deleted'
                              })
                            }
                          }}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </>
        ) : (
          // The confirm button lives in a pinned footer so the height cap on
          // `Picker.Content` can only ever eat into the scrolling body above it.
          <>
            <div className="min-h-0 overflow-y-auto p-2">
              <button
                type="button"
                onClick={() => (mode === 'edit' ? resetState() : setMode('presets'))}
                className="mb-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ChevronRight className="h-3 w-3 rotate-180" />

                {mode === 'edit'
                  ? tPhaseF('phaseF.componentsReminderReminderPicker.editReminder')
                  : tPhaseF('phaseF.componentsReminderReminderPicker.backToPresets')}
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

                    {tPhaseF('phaseF.componentsReminderReminderPicker.time')}
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
                      {tPhaseF('phaseF.componentsReminderReminderPicker.noteOptional')}
                    </Label>
                    <Textarea
                      id="reminder-note"
                      placeholder={tPhaseF(
                        'phaseF.componentsReminderReminderPicker.whyAreYouSettingThisReminder'
                      )}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      className="mt-1.5 h-16 resize-none text-sm"
                    />
                  </div>
                )}
              </div>
            </div>

            <Picker.Footer className="space-y-2 p-2">
              {selectedDate && (
                <div className="text-xs text-muted-foreground">
                  {formatReminderDate(buildSelectedDate() ?? selectedDate, clockFormat)}
                </div>
              )}

              <Button
                onClick={mode === 'edit' ? handleEditSubmit : handleCustomSubmit}
                disabled={!selectedDate || isLoading}
                className="w-full"
                size="sm"
              >
                {mode === 'edit'
                  ? tPhaseF('phaseF.componentsReminderReminderPicker.save')
                  : isLoading
                    ? tPhaseF('phaseF.componentsReminderReminderPicker.setting')
                    : tPhaseF('phaseF.componentsReminderReminderPicker.setReminder')}
              </Button>
            </Picker.Footer>
          </>
        )}
      </Picker.Content>
    </Picker>
  )
}
