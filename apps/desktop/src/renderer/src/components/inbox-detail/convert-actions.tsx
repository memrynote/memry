/**
 * Convert Actions — inbox detail panel
 *
 * Compact Note · Task · Event · Reminder row. Each non-note action opens a
 * small popover form. Binary items (image/pdf/video/clip) can only become a
 * note, so the other actions are disabled with a tooltip. Voice converts via
 * its transcription, so it is NOT treated as binary here.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { FileText, ListTodo, CalendarClock, Bell } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { tasksService } from '@/services/tasks-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import {
  useConvertToNote,
  useConvertToTask,
  useConvertToEvent,
  useConvertToReminder
} from '@/hooks/use-inbox-mutations'
import type { InboxItem, InboxItemListItem } from '@/types'

type ConvertItem = InboxItem | InboxItemListItem

// Items with no usable text body: they can only become a plain note. Mirrors
// isNoteOnlyType in the main process (voice is excluded — transcription is text).
const NOTE_ONLY_TYPES = ['image', 'pdf', 'video', 'clip']

const PRIORITY_OPTIONS = [
  { value: 0, key: 'priorityNone' },
  { value: 1, key: 'priorityLow' },
  { value: 2, key: 'priorityMedium' },
  { value: 3, key: 'priorityHigh' },
  { value: 4, key: 'priorityUrgent' }
] as const

function toIso(localValue: string): string {
  return new Date(localValue).toISOString()
}

interface ConvertActionsProps {
  item: ConvertItem
  onConverted: () => void
}

export const ConvertActions = ({ item, onConverted }: ConvertActionsProps): React.JSX.Element => {
  const { t } = useT('inbox')
  const isNoteOnly = NOTE_ONLY_TYPES.includes(item.type)

  const convertNote = useConvertToNote()
  const convertTask = useConvertToTask()
  const convertEvent = useConvertToEvent()
  const convertReminder = useConvertToReminder()
  const isPending =
    convertNote.isPending ||
    convertTask.isPending ||
    convertEvent.isPending ||
    convertReminder.isPending

  const [openForm, setOpenForm] = useState<'task' | 'event' | 'reminder' | null>(null)

  // Task form state
  const [projectId, setProjectId] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [dueTime, setDueTime] = useState('')
  const [priority, setPriority] = useState('0')

  // Event form state
  const [startAt, setStartAt] = useState('')
  const [endAt, setEndAt] = useState('')
  const [isAllDay, setIsAllDay] = useState(false)
  const [location, setLocation] = useState('')

  // Reminder form state
  const [remindAt, setRemindAt] = useState('')

  const { data: projects = [] } = useQuery({
    queryKey: ['tasks', 'projects'],
    queryFn: async () => (await tasksService.listProjects()).projects,
    enabled: !isNoteOnly
  })

  async function run<R extends { success: boolean; error?: string }>(
    promise: Promise<R>,
    targetLabel: string
  ): Promise<void> {
    try {
      const result = await promise
      if (!result.success) {
        toast.error(t('convert.failed', { error: result.error ?? '' }))
        return
      }
      toast.success(t('convert.success', { target: targetLabel }))
      setOpenForm(null)
      onConverted()
    } catch (error) {
      toast.error(t('convert.failed', { error: extractErrorMessage(error) }))
    }
  }

  const handleNote = (): Promise<void> => run(convertNote.mutateAsync(item.id), t('convert.note'))

  const handleTask = (): Promise<void> =>
    run(
      convertTask.mutateAsync({
        itemId: item.id,
        input: {
          projectId: projectId || undefined,
          dueDate: dueDate || null,
          dueTime: dueTime || null,
          priority: Number(priority)
        }
      }),
      t('convert.task')
    )

  const handleEvent = (): Promise<void> =>
    run(
      convertEvent.mutateAsync({
        itemId: item.id,
        input: {
          startAt: toIso(startAt),
          endAt: endAt ? toIso(endAt) : null,
          isAllDay,
          location: location || null
        }
      }),
      t('convert.event')
    )

  const handleReminder = (): Promise<void> =>
    run(
      convertReminder.mutateAsync({ itemId: item.id, input: { remindAt: toIso(remindAt) } }),
      t('convert.reminder')
    )

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-2 py-4 px-5 border-b border-border">
        <span className="text-[11px] [letter-spacing:0.05em] uppercase text-text-tertiary font-medium leading-3.5">
          {t('convert.title')}
        </span>
        <div className="grid grid-cols-4 gap-1.5">
          {/* Note — always available */}
          <Button
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => void handleNote()}
            className="flex items-center justify-center gap-1.5 text-[12px]"
          >
            <FileText className="size-3.5" aria-hidden="true" />
            {t('convert.note')}
          </Button>

          {/* Task */}
          <ConvertButton
            label={t('convert.task')}
            icon={<ListTodo className="size-3.5" aria-hidden="true" />}
            disabled={isNoteOnly || isPending}
            disabledHint={t('convert.binaryOnlyNote')}
            open={openForm === 'task'}
            onOpenChange={(open) => setOpenForm(open ? 'task' : null)}
          >
            <div className="flex flex-col gap-2.5">
              <Field label={t('convert.project')}>
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t('convert.inboxProject')} />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('convert.dueDate')}>
                  <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                </Field>
                <Field label={t('convert.dueTime')}>
                  <Input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
                </Field>
              </div>
              <Field label={t('convert.priority')}>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={String(opt.value)}>
                        {t(`convert.${opt.key}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Button
                size="sm"
                disabled={isPending}
                onClick={() => void handleTask()}
                className="bg-tint hover:bg-tint-hover text-tint-foreground border-0"
              >
                {t('convert.create')}
              </Button>
            </div>
          </ConvertButton>

          {/* Event */}
          <ConvertButton
            label={t('convert.event')}
            icon={<CalendarClock className="size-3.5" aria-hidden="true" />}
            disabled={isNoteOnly || isPending}
            disabledHint={t('convert.binaryOnlyNote')}
            open={openForm === 'event'}
            onOpenChange={(open) => setOpenForm(open ? 'event' : null)}
          >
            <div className="flex flex-col gap-2.5">
              <Field label={t('convert.start')}>
                <Input
                  type="datetime-local"
                  value={startAt}
                  onChange={(e) => setStartAt(e.target.value)}
                />
              </Field>
              <Field label={t('convert.end')}>
                <Input
                  type="datetime-local"
                  value={endAt}
                  onChange={(e) => setEndAt(e.target.value)}
                />
              </Field>
              <label className="flex items-center gap-2 text-[13px] text-foreground">
                <Checkbox checked={isAllDay} onCheckedChange={(v) => setIsAllDay(v === true)} />
                {t('convert.allDay')}
              </label>
              <Field label={t('convert.location')}>
                <Input value={location} onChange={(e) => setLocation(e.target.value)} />
              </Field>
              <Button
                size="sm"
                disabled={!startAt || isPending}
                onClick={() => void handleEvent()}
                className="bg-tint hover:bg-tint-hover text-tint-foreground border-0"
              >
                {t('convert.create')}
              </Button>
            </div>
          </ConvertButton>

          {/* Reminder */}
          <ConvertButton
            label={t('convert.reminder')}
            icon={<Bell className="size-3.5" aria-hidden="true" />}
            disabled={isNoteOnly || isPending}
            disabledHint={t('convert.binaryOnlyNote')}
            open={openForm === 'reminder'}
            onOpenChange={(open) => setOpenForm(open ? 'reminder' : null)}
          >
            <div className="flex flex-col gap-2.5">
              <Field label={t('convert.remindAt')}>
                <Input
                  type="datetime-local"
                  value={remindAt}
                  onChange={(e) => setRemindAt(e.target.value)}
                />
              </Field>
              <Button
                size="sm"
                disabled={!remindAt || isPending}
                onClick={() => void handleReminder()}
                className="bg-tint hover:bg-tint-hover text-tint-foreground border-0"
              >
                {t('convert.create')}
              </Button>
            </div>
          </ConvertButton>
        </div>
      </div>
    </TooltipProvider>
  )
}

interface ConvertButtonProps {
  label: string
  icon: React.ReactNode
  disabled: boolean
  disabledHint: string
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}

function ConvertButton({
  label,
  icon,
  disabled,
  disabledHint,
  open,
  onOpenChange,
  children
}: ConvertButtonProps): React.JSX.Element {
  const trigger = (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      className="flex items-center justify-center gap-1.5 text-[12px] w-full"
    >
      {icon}
      {label}
    </Button>
  )

  if (disabled) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{trigger}</span>
        </TooltipTrigger>
        <TooltipContent>{disabledHint}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
        {children}
      </PopoverContent>
    </Popover>
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
