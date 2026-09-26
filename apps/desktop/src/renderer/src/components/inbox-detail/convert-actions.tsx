/**
 * Convert form — inbox detail panel.
 *
 * Renders the inline form for a single target type (task / event / reminder),
 * chosen by the panel's TypeSelector. The "note" target is handled by the
 * filing section + File button, not here. Each form owns its own submit so the
 * conversion mutations stay encapsulated in this component.
 */

import { useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'

import { Bell, BellRing, Calendar, Clock, MapPin } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { getActiveLocale } from '@/lib/active-locale'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DatePickerContent } from '@/components/tasks/date-picker-content'
import {
  DatePropertyRow,
  PropertyRow,
  PROPERTY_ROW_TRIGGER,
  PROPERTY_ROW_TRIGGER_NEUTRAL_TEXT,
  PROPERTY_ROW_TRIGGER_PROJECT
} from '@/components/tasks/date-property-row'
import { InteractivePriorityBadge } from '@/components/tasks/interactive-priority-badge'
import { InteractiveDueDateBadge } from '@/components/tasks/interactive-due-date-badge'
import { InteractiveProjectBadge } from '@/components/tasks/interactive-project-badge'
import { ReminderPicker } from '@/components/reminder'
import { formatReminderDate, standardPresets } from '@/components/reminder/reminder-presets'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { dbProjectToUiProject } from '@/features/tasks/use-task-queries'
import { tasksService } from '@/services/tasks-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import {
  useConvertToTask,
  useConvertToEvent,
  useConvertToReminder
} from '@/hooks/use-inbox-mutations'
import { useCreateReminder } from '@/hooks/use-reminders'
import type { Priority } from '@/data/task-model'
import type { InboxItem, InboxItemListItem } from '@/types'
import type { ConvertType } from './convert-types'
import { FOOTER_ACTION_CLASS } from './footer-action'

type ConvertItem = InboxItem | InboxItemListItem

const PRIORITY_TO_NUM: Record<Priority, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4
}

function combineDateTime(date: Date, time: string): string {
  const [hours, minutes] = time.split(':').map(Number)
  const at = new Date(date)
  at.setHours(hours, minutes, 0, 0)
  return at.toISOString()
}

function formatDateValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

interface ConvertActionsProps {
  item: ConvertItem
  type: Exclude<ConvertType, 'note'>
  onConverted: () => void
  /**
   * The panel footer's end slot. The submit button is portalled there so it
   * sits beside Archive like the File button does; without a slot (tests,
   * other hosts) it renders under the form.
   */
  primaryActionSlot?: HTMLElement | null
}

// A row on the drawer's icon lane that holds something other than a trigger
// (time inputs, a location input). Matches PropertyRow's hover/focus tint.
const FIELD_ROW =
  'flex h-8 min-w-0 items-center gap-2.5 rounded-md px-2 text-[13px] leading-[18px] transition-colors duration-150 hover:bg-surface-active/60 focus-within:bg-surface-active/60'

const BARE_INPUT =
  'min-w-0 border-0 bg-transparent p-0 text-text-primary placeholder:text-text-tertiary outline-none focus:outline-none'

// Presets shown inline for the reminder target; anything else goes through
// the full picker behind "Custom…".
const INLINE_REMINDER_PRESETS = ['later-today', 'tomorrow', 'next-week']

export const ConvertActions = ({
  item,
  type,
  onConverted,
  primaryActionSlot
}: ConvertActionsProps): React.JSX.Element => {
  const { t } = useT('inbox')
  const formId = useId()

  const convertTask = useConvertToTask()
  const convertEvent = useConvertToEvent()
  const convertReminder = useConvertToReminder()
  const createReminder = useCreateReminder()
  const isPending = convertTask.isPending || convertEvent.isPending || convertReminder.isPending
  const {
    settings: { clockFormat }
  } = useGeneralSettings()

  // Task form state — mirrors the task detail drawer (status is intentionally omitted).
  const [projectId, setProjectId] = useState('')
  const [dueDate, setDueDate] = useState<Date | null>(null)
  const [dueTime, setDueTime] = useState<string | null>(null)
  const [priority, setPriority] = useState<Priority>('none')
  const [remindAt, setRemindAt] = useState<Date | null>(null)
  const [remindNote, setRemindNote] = useState<string | null>(null)

  // Event form state
  const [eventDate, setEventDate] = useState<Date | undefined>(undefined)
  const [isEventDateOpen, setIsEventDateOpen] = useState(false)
  const [startTime, setStartTime] = useState<string | null>('09:00')
  const [endTime, setEndTime] = useState<string | null>('10:00')
  const [isAllDay, setIsAllDay] = useState(false)
  const [location, setLocation] = useState('')

  // Reminder form state
  const [reminderAt, setReminderAt] = useState<Date | null>(null)
  const [reminderPresetId, setReminderPresetId] = useState<string | null>(null)

  const { data: projects = [] } = useQuery({
    queryKey: ['tasks', 'projects'],
    queryFn: async () => (await tasksService.listProjects()).projects.map(dbProjectToUiProject),
    enabled: type === 'task'
  })

  // Default to the inbox project so the badge reads like the task drawer (never empty).
  const effectiveProjectId = projectId || (projects.find((p) => p.isDefault)?.id ?? '')

  async function run<R extends { success: boolean; error?: string }>(
    promise: Promise<R>,
    targetLabel: string
  ): Promise<void> {
    try {
      const result = await promise
      if (!result.success) {
        trackRendererError('inbox_convert_failed', result.error)
        toast.error(t('convert.failed', { error: result.error ?? '' }))
        return
      }
      toast.success(t('convert.success', { target: targetLabel }))
      onConverted()
    } catch (error) {
      trackRendererError('inbox_convert_failed', error)
      toast.error(t('convert.failed', { error: extractErrorMessage(error) }))
    }
  }

  const handleTask = async (): Promise<void> => {
    try {
      const result = await convertTask.mutateAsync({
        itemId: item.id,
        input: {
          projectId: effectiveProjectId || undefined,
          dueDate: dueDate ? formatDateValue(dueDate) : null,
          dueTime: dueTime || null,
          priority: PRIORITY_TO_NUM[priority]
        }
      })
      if (!result.success || !result.taskId) {
        trackRendererError('inbox_convert_failed', result.error)
        toast.error(t('convert.failed', { error: result.error ?? '' }))
        return
      }
      // Reminders attach to a task, so they can only be created after conversion.
      if (remindAt) {
        await createReminder.mutateAsync({
          targetType: 'task',
          targetId: result.taskId,
          remindAt: remindAt.toISOString(),
          note: remindNote ?? undefined
        })
      }
      toast.success(t('convert.success', { target: t('convert.task') }))
      onConverted()
    } catch (error) {
      trackRendererError('inbox_convert_failed', error)
      toast.error(t('convert.failed', { error: extractErrorMessage(error) }))
    }
  }

  const handleEvent = (): Promise<void> => {
    if (!eventDate) return Promise.resolve()
    const startAt = combineDateTime(eventDate, isAllDay ? '00:00' : (startTime ?? '09:00'))
    const endAt = isAllDay ? null : combineDateTime(eventDate, endTime ?? startTime ?? '10:00')
    return run(
      convertEvent.mutateAsync({
        itemId: item.id,
        input: { startAt, endAt, isAllDay, location: location || null }
      }),
      t('convert.event')
    )
  }

  const handleReminder = (): Promise<void> => {
    if (!reminderAt) return Promise.resolve()
    return run(
      convertReminder.mutateAsync({
        itemId: item.id,
        input: { remindAt: reminderAt.toISOString() }
      }),
      t('convert.reminder')
    )
  }

  const submit = {
    task: { label: t('convert.addTask'), disabled: isPending, run: handleTask },
    event: { label: t('convert.addEvent'), disabled: !eventDate || isPending, run: handleEvent },
    reminder: {
      label: t('convert.setReminder'),
      disabled: !reminderAt || isPending,
      run: handleReminder
    }
  }[type]

  const primaryAction = (
    <Button
      type="submit"
      form={formId}
      size="sm"
      disabled={submit.disabled}
      className={cn(FOOTER_ACTION_CLASS, 'min-w-0')}
    >
      {submit.label}
    </Button>
  )

  const inlinePresets = standardPresets.filter((p) => INLINE_REMINDER_PRESETS.includes(p.id))

  return (
    <>
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault()
          if (!submit.disabled) void submit.run()
        }}
        // px-3 + each row's px-2 puts every icon on the drawer's 20px lane.
        className="flex flex-col gap-0.5 px-3 pt-1.5 pb-3"
      >
        {type === 'task' && (
          <>
            <PropertyRow label={t('convert.priority')}>
              <InteractivePriorityBadge
                priority={priority}
                onPriorityChange={setPriority}
                className={PROPERTY_ROW_TRIGGER_NEUTRAL_TEXT}
              />
            </PropertyRow>
            <DatePropertyRow
              label={t('convert.dueDate')}
              date={dueDate}
              kind="due"
              isCompleted={false}
            >
              <InteractiveDueDateBadge
                dueDate={dueDate}
                dueTime={dueTime}
                onDateChange={setDueDate}
                onTimeChange={setDueTime}
                variant="property"
                className={PROPERTY_ROW_TRIGGER}
              />
            </DatePropertyRow>
            <PropertyRow label={t('convert.reminder')}>
              <ReminderPicker
                onSelect={(date, note) => {
                  setRemindAt(date)
                  setRemindNote(note ?? null)
                }}
                presetType="standard"
                telemetrySurface="inbox"
                showNote
                trigger={
                  <button
                    type="button"
                    aria-label={
                      remindAt
                        ? formatReminderDate(remindAt, clockFormat)
                        : t('convert.setReminder')
                    }
                    className={cn(
                      PROPERTY_ROW_TRIGGER,
                      'flex items-center cursor-pointer focus-visible:outline-none',
                      remindAt ? 'text-text-primary' : 'font-normal text-text-tertiary'
                    )}
                  >
                    {remindAt ? (
                      <BellRing className="text-amber-500" aria-hidden="true" />
                    ) : (
                      <Bell className="text-text-tertiary" aria-hidden="true" />
                    )}
                    <span className="min-w-0 truncate">
                      {remindAt
                        ? formatReminderDate(remindAt, clockFormat, true)
                        : t('convert.setReminder')}
                    </span>
                  </button>
                }
              />
            </PropertyRow>
            <PropertyRow label={t('convert.project')}>
              <InteractiveProjectBadge
                projectId={effectiveProjectId}
                projects={projects}
                onProjectChange={setProjectId}
                className={PROPERTY_ROW_TRIGGER_PROJECT}
              />
            </PropertyRow>
          </>
        )}

        {type === 'event' && (
          <>
            <PropertyRow label={t('convert.date')}>
              <Popover open={isEventDateOpen} onOpenChange={setIsEventDateOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      PROPERTY_ROW_TRIGGER,
                      'flex items-center cursor-pointer focus-visible:outline-none',
                      eventDate ? 'text-text-primary' : 'font-normal text-text-tertiary'
                    )}
                  >
                    <Calendar className="text-text-tertiary" aria-hidden="true" />
                    <span className="min-w-0 truncate">
                      {eventDate ? formatEventDate(eventDate) : t('convert.date')}
                    </span>
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  className="w-auto p-0 rounded-md overflow-clip flex flex-col max-h-(--radix-popover-content-available-height)"
                  align="start"
                >
                  <DatePickerContent
                    selected={eventDate ?? null}
                    onSelect={(date) => {
                      setEventDate(date ?? undefined)
                      setIsEventDateOpen(false)
                    }}
                    showRemoveDate={!!eventDate}
                  />
                </PopoverContent>
              </Popover>
            </PropertyRow>

            <div className={FIELD_ROW}>
              <Clock className="size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
              {isAllDay ? (
                <span className="flex-1 font-medium text-text-primary">{t('convert.allDay')}</span>
              ) : (
                <div className="flex min-w-0 flex-1 items-center gap-1 font-medium">
                  <input
                    type="time"
                    value={startTime ?? ''}
                    onChange={(e) => setStartTime(e.target.value || null)}
                    aria-label={t('convert.start')}
                    className={cn(BARE_INPUT, 'w-[76px]')}
                  />
                  <span aria-hidden="true" className="text-text-tertiary">
                    –
                  </span>
                  <input
                    type="time"
                    value={endTime ?? ''}
                    onChange={(e) => setEndTime(e.target.value || null)}
                    aria-label={t('convert.end')}
                    className={cn(BARE_INPUT, 'w-[76px]')}
                  />
                </div>
              )}
              <label className="flex shrink-0 items-center gap-2 text-[12px] leading-4 text-text-tertiary">
                {!isAllDay && t('convert.allDay')}
                <Switch
                  checked={isAllDay}
                  onCheckedChange={setIsAllDay}
                  aria-label={t('convert.allDay')}
                />
              </label>
            </div>

            <div className={FIELD_ROW}>
              <MapPin className="size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
              <input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder={t('convert.location')}
                aria-label={t('convert.location')}
                className={cn(BARE_INPUT, 'flex-1')}
              />
            </div>
          </>
        )}

        {type === 'reminder' && (
          <>
            <div title={t('convert.remindAt')} className="flex h-8 items-center gap-2.5 px-2">
              <Bell
                className={cn(
                  'size-3.5 shrink-0',
                  reminderAt ? 'text-amber-500' : 'text-text-tertiary'
                )}
                aria-hidden="true"
              />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-[13px] leading-[18px]',
                  reminderAt ? 'font-medium text-text-primary' : 'text-text-tertiary'
                )}
              >
                {reminderAt ? formatReminderDate(reminderAt, clockFormat) : t('convert.remindAt')}
              </span>
            </div>
            <div
              role="group"
              aria-label={t('convert.remindAt')}
              className="flex flex-wrap gap-1 ps-[34px] pe-2"
            >
              {inlinePresets.map((preset) => {
                const selected = reminderPresetId === preset.id
                return (
                  <button
                    key={preset.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      setReminderAt(preset.getDate())
                      setReminderPresetId(preset.id)
                    }}
                    className={cn(
                      'h-6 rounded-md px-2 text-[12px] leading-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                      selected
                        ? 'bg-primary font-medium text-primary-foreground'
                        : 'border border-border text-text-secondary hover:bg-surface-active/60 hover:text-text-primary'
                    )}
                  >
                    {preset.label}
                  </button>
                )
              })}
              <ReminderPicker
                onSelect={(date) => {
                  setReminderAt(date)
                  setReminderPresetId(null)
                }}
                presetType="standard"
                telemetrySurface="inbox"
                trigger={
                  <button
                    type="button"
                    className={cn(
                      'h-6 rounded-md px-2 text-[12px] leading-4 transition-colors hover:bg-surface-active/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                      reminderAt && !reminderPresetId
                        ? 'bg-primary font-medium text-primary-foreground hover:bg-primary'
                        : 'text-text-secondary hover:text-text-primary'
                    )}
                  >
                    {t('reminder.custom')}
                  </button>
                }
              />
            </div>
          </>
        )}
      </form>

      {primaryActionSlot === undefined || primaryActionSlot === null ? (
        <div className="flex justify-end px-5 pb-3">{primaryAction}</div>
      ) : (
        createPortal(primaryAction, primaryActionSlot)
      )}
    </>
  )
}

function formatEventDate(date: Date): string {
  return new Intl.DateTimeFormat(getActiveLocale(), {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  }).format(date)
}
