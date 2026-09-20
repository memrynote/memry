import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'

import { Bell, CalendarClock, ChevronRight, Hash, Plus, Repeat } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { CheckMark } from '@/components/ui/check-mark'
import { FilterSearchHeader } from '@/components/ui/filter-search-header'
import { Picker } from '@/components/ui/picker'
import { StatusDot } from '@/components/ui/status-dot'
import { DatePickerContent } from '@/components/tasks/date-picker-content'
import { InteractiveProjectBadge } from '@/components/tasks/interactive-project-badge'
import { TaskReminderButton } from '@/components/tasks/task-reminder-button'
import { TaskTagsBadge } from '@/components/tasks/task-badges'
import { getTagColors } from '@/components/note/tags-row'
import { useNoteTagsQuery } from '@/hooks/use-notes-query'
import { useTaskReminders } from '@/hooks/use-task-reminders'
import { formatDateShort, formatDueDate } from '@/lib/task-utils'
import { getRepeatDisplayText, getRepeatPresets } from '@/lib/repeat-utils'
import type { RepeatConfig, Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { useT } from '@memry/i18n/renderer'

/**
 * The properties a task can be missing. Status, priority and project always
 * resolve to a value, so they are permanent row controls and deliberately have
 * no entry here — putting them in an "add" menu as well would be the same
 * control in two places.
 */
type ChipId = 'dates' | 'reminder' | 'repeat' | 'tags'

type AddId = 'dueDate' | 'startDate' | 'reminder' | 'repeat' | 'tags'

/**
 * A task row shows at most three tag chips before collapsing to `+N`. In a note
 * column, which is narrower than the Tasks page, two is the honest number.
 */
const MAX_VISIBLE_TAGS = 2

export interface TaskMetaEditing {
  onUpdate: (updates: Partial<Task>) => void
  onProjectChange: (projectId: string) => void
}

interface TaskMetaStripProps extends TaskMetaEditing {
  task: Task
  project: Project
  projects: Project[]
  isCompleted: boolean
}

/**
 * Every optional property of an inline task, editable without leaving the note
 * (#2241).
 *
 * One rule decides where a property lives: it is a chip in the row when it has
 * a value, and a row in the add menu when it does not. Nothing is ever in both
 * places, so the menu erodes as the task fills up and disappears once there is
 * nothing left to add.
 *
 * The menu holds no editors, only labels. Picking one mounts that chip and
 * opens its picker in the same gesture, which keeps exactly one popover on
 * screen — a Radix popover nested inside another fights over dismissal.
 */
export const TaskMetaStrip = ({
  task,
  project,
  projects,
  isCompleted,
  onUpdate,
  onProjectChange
}: TaskMetaStripProps): React.JSX.Element => {
  const [openChip, setOpenChip] = useState<ChipId | null>(null)
  const [dateKind, setDateKind] = useState<'start' | 'due'>('due')
  const { hasActiveReminder } = useTaskReminders(task.id)

  const has: Record<ChipId, boolean> = {
    dates: task.dueDate !== null || (task.startDate ?? null) !== null,
    reminder: hasActiveReminder,
    repeat: task.repeatConfig !== null,
    tags: task.tags.length > 0
  }

  // A chip is on screen when it carries a value or when it is the one the add
  // menu just opened. That single condition is what lets the menu mount and
  // open a chip in one gesture.
  const shows = (id: ChipId): boolean => has[id] || openChip === id
  const toggle = (id: ChipId) => (open: boolean) => setOpenChip(open ? id : null)

  const missing: AddId[] = [
    ...(task.dueDate ? [] : (['dueDate'] as const)),
    ...((task.startDate ?? null) ? [] : (['startDate'] as const)),
    ...(has.reminder ? [] : (['reminder'] as const)),
    ...(has.repeat ? [] : (['repeat'] as const)),
    ...(has.tags ? [] : (['tags'] as const))
  ]

  const openFromMenu = useCallback((id: AddId) => {
    if (id === 'dueDate' || id === 'startDate') {
      setDateKind(id === 'dueDate' ? 'due' : 'start')
      setOpenChip('dates')
      return
    }
    setOpenChip(id)
  }, [])

  return (
    <div className="flex items-center gap-2 shrink-0">
      {shows('repeat') && (
        <RepeatChip
          config={task.repeatConfig}
          dueDate={task.dueDate}
          open={openChip === 'repeat'}
          onOpenChange={toggle('repeat')}
          onChange={(repeatConfig) => onUpdate({ repeatConfig })}
        />
      )}

      {shows('tags') && (
        <TagPanel
          task={task}
          open={openChip === 'tags'}
          onOpenChange={toggle('tags')}
          onUpdate={onUpdate}
        />
      )}

      {shows('dates') && (
        <DatesChip
          task={task}
          isCompleted={isCompleted}
          kind={dateKind}
          onKindChange={setDateKind}
          open={openChip === 'dates'}
          onOpenChange={toggle('dates')}
          onUpdate={onUpdate}
        />
      )}

      {shows('reminder') && (
        <TaskReminderButton
          taskId={task.id}
          open={openChip === 'reminder'}
          onOpenChange={toggle('reminder')}
          className="py-0.5 px-1.5 text-[11px]"
        />
      )}

      <div className="shrink-0" onClick={(event) => event.stopPropagation()}>
        <InteractiveProjectBadge
          projectId={project.id}
          projects={projects}
          onProjectChange={onProjectChange}
        />
      </div>

      {missing.length > 0 && <AddMenu missing={missing} onSelect={openFromMenu} />}
    </div>
  )
}

// ============================================================================
// SHARED CHIP CHROME
// ============================================================================

const chipClasses =
  'flex items-center gap-1 shrink-0 whitespace-nowrap rounded-[5px] border border-foreground/10 bg-foreground/[0.03] dark:bg-foreground/[0.06] py-0.5 px-1.5 text-[11px] leading-4 text-text-secondary transition-opacity hover:opacity-80 focus-visible:outline-none'

const stopRowActivation = (event: React.SyntheticEvent): void => event.stopPropagation()

interface ChipTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  icon: React.ReactNode
  tone?: 'default' | 'overdue'
}

/**
 * forwardRef because this *is* the popover trigger. Wrapping it in a div
 * instead would leave the click stuck on the inner button, which stops
 * propagation so the row underneath does not treat a chip click as a row click.
 */
const ChipTrigger = React.forwardRef<HTMLButtonElement, ChipTriggerProps>(
  ({ label, icon, tone = 'default', className, onClick, onPointerDown, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onClick?.(event)
      }}
      onPointerDown={(event) => {
        event.stopPropagation()
        onPointerDown?.(event)
      }}
      className={cn(
        chipClasses,
        tone === 'overdue' &&
          'border-task-due-overdue/40 bg-task-due-overdue-bg/60 text-task-due-overdue',
        className
      )}
      {...props}
    >
      {icon}
      <span className="truncate max-w-[110px]">{label}</span>
    </button>
  )
)
ChipTrigger.displayName = 'ChipTrigger'

const PanelHeader = ({ label }: { label: string }): React.JSX.Element => (
  <div className="flex items-center py-2 px-3 border-b border-border">
    <span className="text-[13px] text-foreground font-medium leading-4">{label}</span>
  </div>
)

const PanelRow = ({
  selected,
  onSelect,
  icon,
  label
}: {
  selected: boolean
  onSelect: () => void
  icon: React.ReactNode
  label: string
}): React.JSX.Element => (
  <button
    type="button"
    onClick={onSelect}
    className={cn(
      'flex items-center rounded-[5px] py-1.5 px-2 gap-2 transition-colors',
      selected ? 'bg-accent' : 'hover:bg-accent'
    )}
  >
    <span className="flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
    <span
      className={cn(
        'truncate text-[13px] leading-4',
        selected ? 'text-foreground' : 'text-muted-foreground'
      )}
    >
      {label}
    </span>
    {selected && <CheckMark className="ms-auto text-foreground" />}
  </button>
)

// ============================================================================
// ADD MENU
// ============================================================================

const ADD_ICONS: Record<AddId, React.ReactNode> = {
  dueDate: <CalendarClock size={13} className="text-text-tertiary" />,
  startDate: <ChevronRight size={13} className="text-text-tertiary" />,
  reminder: <Bell size={13} className="text-text-tertiary" />,
  repeat: <Repeat size={13} className="text-text-tertiary" />,
  tags: <Hash size={13} className="text-text-tertiary" />
}

const AddMenu = ({
  missing,
  onSelect
}: {
  missing: AddId[]
  onSelect: (id: AddId) => void
}): React.JSX.Element => {
  const { t } = useT('tasks')
  const [open, setOpen] = useState(false)

  const labels: Record<AddId, string> = {
    dueDate: t('inlineContext.dueDate'),
    startDate: t('task.startDate'),
    reminder: t('task.reminder'),
    repeat: t('task.repeat'),
    tags: t('task.tags')
  }

  return (
    <Picker open={open} onOpenChange={setOpen}>
      <Picker.Trigger asChild>
        <button
          type="button"
          aria-label={t('inlineContext.trigger')}
          title={t('inlineContext.trigger')}
          onClick={stopRowActivation}
          onPointerDown={stopRowActivation}
          className={cn(
            'shrink-0 rounded p-0.5 transition-opacity hover:bg-accent/80',
            open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
          )}
        >
          <Plus className="size-3 text-muted-foreground" />
        </button>
      </Picker.Trigger>
      <Picker.Content width={200} align="end" sideOffset={6}>
        <Picker.List>
          {missing.map((id) => (
            <PanelRow
              key={id}
              selected={false}
              icon={ADD_ICONS[id]}
              label={labels[id]}
              onSelect={() => {
                setOpen(false)
                onSelect(id)
              }}
            />
          ))}
        </Picker.List>
      </Picker.Content>
    </Picker>
  )
}

// ============================================================================
// DATES — one chip, one calendar, a Start | Due segment
// ============================================================================

const DatesChip = ({
  task,
  isCompleted,
  kind,
  onKindChange,
  open,
  onOpenChange,
  onUpdate
}: {
  task: Task
  isCompleted: boolean
  kind: 'start' | 'due'
  onKindChange: (kind: 'start' | 'due') => void
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdate: (updates: Partial<Task>) => void
}): React.JSX.Element => {
  const { t } = useT('tasks')
  const startDate = task.startDate ?? null
  const selected = kind === 'due' ? task.dueDate : startDate

  // Two date chips side by side is noise and two calendars is worse, so the
  // pair reads as one range.
  const label = (() => {
    if (startDate && task.dueDate)
      return `${formatDateShort(startDate)} → ${formatDateShort(task.dueDate)}`
    if (task.dueDate) return formatDateShort(task.dueDate)
    if (startDate) return `${formatDateShort(startDate)} →`
    return t('inlineContext.setDate')
  })()

  const isOverdue =
    !isCompleted &&
    task.dueDate !== null &&
    formatDueDate(task.dueDate, task.dueTime)?.status === 'overdue'

  return (
    <Picker open={open} onOpenChange={onOpenChange}>
      <Picker.Trigger asChild>
        <ChipTrigger
          label={label}
          aria-label={t('inlineContext.dueDate')}
          tone={isOverdue ? 'overdue' : 'default'}
          icon={
            <CalendarClock
              size={11}
              className={cn('shrink-0', !isOverdue && 'text-text-tertiary')}
            />
          }
        />
      </Picker.Trigger>
      <Picker.Content width={240} align="end" sideOffset={6}>
        <div className="flex gap-0.5 p-1.5 border-b border-border">
          {(['start', 'due'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onKindChange(value)}
              className={cn(
                'grow rounded-[5px] py-1 text-[12px] font-medium transition-colors',
                kind === value
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-accent'
              )}
            >
              {value === 'due' ? t('task.dueDate') : t('task.startDate')}
            </button>
          ))}
        </div>
        <DatePickerContent
          selected={selected}
          time={kind === 'due' ? task.dueTime : null}
          onSelect={(date) => {
            if (kind === 'start') {
              onUpdate({ startDate: date })
              return
            }
            // A time with no day is unreachable in every view, so clearing the
            // date takes the time with it.
            onUpdate(date ? { dueDate: date } : { dueDate: null, dueTime: null })
          }}
          onTimeChange={kind === 'due' ? (dueTime) => onUpdate({ dueTime }) : undefined}
        />
      </Picker.Content>
    </Picker>
  )
}

// ============================================================================
// REPEAT
// ============================================================================

const RepeatChip = ({
  config,
  dueDate,
  open,
  onOpenChange,
  onChange
}: {
  config: RepeatConfig | null
  dueDate: Date | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (config: RepeatConfig | null) => void
}): React.JSX.Element => {
  const { t } = useT('tasks')
  const { t: tCommon } = useT('common')
  const presets = useMemo(() => getRepeatPresets(dueDate), [dueDate])
  const currentText = config ? getRepeatDisplayText(config, tCommon) : null

  return (
    <Picker open={open} onOpenChange={onOpenChange}>
      <Picker.Trigger asChild>
        <ChipTrigger
          label={currentText ?? t('inlineContext.setRepeat')}
          aria-label={t('task.repeat')}
          icon={<Repeat size={11} className="shrink-0 text-task-repeat" />}
        />
      </Picker.Trigger>
      <Picker.Content width={220} align="end" sideOffset={6}>
        <PanelHeader label={t('task.repeat')} />
        <Picker.List className="max-h-56">
          {presets.map((preset) => (
            <PanelRow
              key={preset.id}
              selected={currentText === getRepeatDisplayText(preset.config, tCommon)}
              icon={<Repeat size={13} className="text-text-tertiary" />}
              label={preset.label}
              onSelect={() => {
                onChange(preset.config)
                onOpenChange(false)
              }}
            />
          ))}
          {config && (
            <PanelRow
              selected={false}
              icon={<Repeat size={13} className="text-text-tertiary" />}
              label={t('inlineContext.clearRepeat')}
              onSelect={() => {
                onChange(null)
                onOpenChange(false)
              }}
            />
          )}
        </Picker.List>
      </Picker.Content>
    </Picker>
  )
}

// ============================================================================
// TAGS
// ============================================================================

/**
 * The tag group is the trigger. An empty task has no group to click, which is
 * exactly why "Tag" is in the add menu until the first one lands.
 */
const TagPanel = ({
  task,
  open,
  onOpenChange,
  onUpdate
}: {
  task: Task
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdate: (updates: Partial<Task>) => void
}): React.JSX.Element => {
  const { t } = useT('tasks')
  const [query, setQuery] = useState('')
  const { tags: tagDefs } = useNoteTagsQuery({ enabled: open })

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? tagDefs.filter((def) => def.tag.toLowerCase().includes(needle)) : tagDefs
  }, [tagDefs, query])

  const trimmedQuery = query.trim()
  const canCreate =
    trimmedQuery.length > 0 &&
    !tagDefs.some((def) => def.tag.toLowerCase() === trimmedQuery.toLowerCase())

  const toggle = useCallback(
    (tag: string) => {
      const has = task.tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())
      onUpdate({
        tags: has
          ? task.tags.filter((existing) => existing.toLowerCase() !== tag.toLowerCase())
          : [...task.tags, tag]
      })
    },
    [task.tags, onUpdate]
  )

  return (
    <Picker open={open} onOpenChange={onOpenChange} closeOnSelect={false}>
      <Picker.Trigger asChild>
        {/* A div, not the badge itself: it takes the popover's ref, and it
            still anchors the panel on a task whose last tag was just removed,
            where the badge renders nothing. */}
        <div
          role="button"
          tabIndex={0}
          aria-label={t('task.tags')}
          onClick={stopRowActivation}
          onPointerDown={stopRowActivation}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            event.currentTarget.click()
          }}
          className="shrink-0 cursor-pointer rounded-[5px] hover:opacity-80 focus-visible:outline-none"
        >
          {task.tags.length > 0 ? (
            <TaskTagsBadge tags={task.tags} size="sm" maxVisible={MAX_VISIBLE_TAGS} nowrap />
          ) : (
            <span className={chipClasses}>
              <Hash size={11} className="shrink-0 text-text-tertiary" />
              {t('task.tags')}
            </span>
          )}
        </div>
      </Picker.Trigger>
      <Picker.Content width={220} align="end" sideOffset={6}>
        <PanelHeader label={t('task.tags')} />
        <FilterSearchHeader
          value={query}
          onChange={setQuery}
          placeholder={t('inlineContext.searchTags')}
          className="py-1.5"
        />
        <Picker.List className="max-h-56">
          {canCreate && (
            <PanelRow
              selected={false}
              icon={<Hash size={13} className="text-text-tertiary" />}
              label={t('inlineContext.createTag', { name: trimmedQuery })}
              onSelect={() => {
                toggle(trimmedQuery)
                setQuery('')
              }}
            />
          )}
          {filtered.map((def) => (
            <PanelRow
              key={def.tag}
              selected={task.tags.some(
                (existing) => existing.toLowerCase() === def.tag.toLowerCase()
              )}
              icon={<StatusDot color={getTagColors(def.color, def.tag).text} />}
              label={def.tag}
              onSelect={() => toggle(def.tag)}
            />
          ))}
        </Picker.List>
      </Picker.Content>
    </Picker>
  )
}
