/**
 * Convert form — inbox detail panel.
 *
 * Renders the inline form for a single target type (task / event / reminder),
 * chosen by the panel's TypeSelector. The "note" target is handled by the
 * filing section + File button, not here. Each form owns its own submit so the
 * conversion mutations stay encapsulated in this component.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'

import { Bell, BellRing } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { DatePickerCalendar } from '@/components/tasks/date-picker-calendar'
import { TimePicker } from '@/components/tasks/time-picker'
import { InteractivePriorityBadge } from '@/components/tasks/interactive-priority-badge'
import { InteractiveDueDateBadge } from '@/components/tasks/interactive-due-date-badge'
import { InteractiveProjectBadge } from '@/components/tasks/interactive-project-badge'
import { ReminderPicker } from '@/components/reminder'
import { formatReminderDate } from '@/components/reminder/reminder-presets'
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
}

export const ConvertActions = ({
  item,
  type,
  onConverted
}: ConvertActionsProps): React.JSX.Element => {
  const { t } = useT('inbox')

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
  const [startTime, setStartTime] = useState<string | null>('09:00')
  const [endTime, setEndTime] = useState<string | null>('10:00')
  const [isAllDay, setIsAllDay] = useState(false)
  const [location, setLocation] = useState('')

  // Reminder form state
  const [remindDate, setRemindDate] = useState<Date | undefined>(undefined)
  const [remindTime, setRemindTime] = useState('09:00')

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
    if (!remindDate) return Promise.resolve()
    const [hours, minutes] = remindTime.split(':').map(Number)
    const at = new Date(remindDate)
    at.setHours(hours, minutes, 0, 0)
    return run(
      convertReminder.mutateAsync({ itemId: item.id, input: { remindAt: at.toISOString() } }),
      t('convert.reminder')
    )
  }

  return (
    <div className="flex flex-col gap-2.5 py-4 px-5 border-b border-border">
      {type === 'task' && (
        <>
          {/* Mirrors the task detail drawer property grid (status omitted). */}
          <div className="flex flex-col">
            <PropRow label={t('convert.priority')}>
              <InteractivePriorityBadge
                priority={priority}
                onPriorityChange={setPriority}
                compact
              />
            </PropRow>
            <PropRow label={t('convert.dueDate')}>
              <InteractiveDueDateBadge
                dueDate={dueDate}
                dueTime={dueTime}
                onDateChange={setDueDate}
                onTimeChange={setDueTime}
              />
            </PropRow>
            <PropRow label={t('convert.reminder')}>
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
                      'flex items-center gap-1.5 cursor-pointer whitespace-nowrap rounded-[5px] py-[3px] px-2 border border-solid',
                      'border-foreground/10 bg-foreground/[0.03] dark:bg-foreground/[0.06]',
                      'transition-opacity hover:opacity-80 focus-visible:outline-none',
                      remindAt ? 'text-text-secondary' : 'text-text-tertiary'
                    )}
                  >
                    {remindAt ? (
                      <BellRing className="size-3 shrink-0 text-amber-500" />
                    ) : (
                      <Bell className="size-3 shrink-0" />
                    )}
                    <span className="text-[12px] leading-4">
                      {remindAt
                        ? formatReminderDate(remindAt, clockFormat, true)
                        : t('convert.setReminder')}
                    </span>
                  </button>
                }
              />
            </PropRow>
            <PropRow label={t('convert.project')}>
              <InteractiveProjectBadge
                projectId={effectiveProjectId}
                projects={projects}
                onProjectChange={setProjectId}
              />
            </PropRow>
          </div>
          <Button
            size="sm"
            disabled={isPending}
            onClick={() => void handleTask()}
            className="bg-tint hover:bg-tint-hover text-tint-foreground border-0"
          >
            {t('convert.addTask')}
          </Button>
        </>
      )}

      {type === 'event' && (
        <>
          <Field label={t('convert.date')}>
            <DatePickerCalendar
              selected={eventDate}
              onSelect={setEventDate}
              className="rounded-md border p-2"
            />
          </Field>
          {!isAllDay && (
            <div className="grid grid-cols-2 gap-2">
              <Field label={t('convert.start')}>
                <TimePicker value={startTime} onChange={setStartTime} />
              </Field>
              <Field label={t('convert.end')}>
                <TimePicker value={endTime} onChange={setEndTime} />
              </Field>
            </div>
          )}
          <label className="flex items-center gap-2 text-[13px] text-foreground">
            <Checkbox checked={isAllDay} onCheckedChange={(v) => setIsAllDay(v === true)} />
            {t('convert.allDay')}
          </label>
          <Field label={t('convert.location')}>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} />
          </Field>
          <Button
            size="sm"
            disabled={!eventDate || isPending}
            onClick={() => void handleEvent()}
            className="bg-tint hover:bg-tint-hover text-tint-foreground border-0"
          >
            {t('convert.addEvent')}
          </Button>
        </>
      )}

      {type === 'reminder' && (
        <>
          <Field label={t('convert.remindAt')}>
            <DatePickerCalendar
              selected={remindDate}
              onSelect={setRemindDate}
              disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0))}
              className="rounded-md border p-2"
            />
          </Field>
          <Field label={t('convert.time')}>
            <TimePicker value={remindTime} onChange={(v) => setRemindTime(v ?? '09:00')} />
          </Field>
          <Button
            size="sm"
            disabled={!remindDate || isPending}
            onClick={() => void handleReminder()}
            className="bg-tint hover:bg-tint-hover text-tint-foreground border-0"
          >
            {t('convert.setReminder')}
          </Button>
        </>
      )}
    </div>
  )
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-[11px] uppercase [letter-spacing:0.05em] text-text-tertiary">
      {label}
      <div className="normal-case [letter-spacing:normal]">{children}</div>
    </label>
  )
}

// Label-left / control-right row, matching the task detail drawer property grid.
function PropRow({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center py-1.5">
      <span className="text-[12px] w-[90px] shrink-0 text-text-tertiary leading-4">{label}</span>
      {children}
    </div>
  )
}
