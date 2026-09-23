import { useState } from 'react'
import { Command as CommandPrimitive } from 'cmdk'
import { useT } from '@memry/i18n/renderer'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DatePickerCalendar } from '@/components/tasks/date-picker-calendar'
import type { Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { modifierKey } from '@/hooks/use-keyboard-shortcuts'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Calendar,
  CheckCircle,
  Circle,
  Clock,
  CornerDownLeft,
  Eraser,
  FolderInput
} from '@/lib/icons'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import { CalendarCardHeader } from './calendar-card'
import { toLocalDateString } from './date-utils'

export type TimelinePanelPage = 'root' | 'start' | 'due' | 'project'

export type TimelineTaskAction =
  | 'open'
  | 'open-in-tasks'
  | 'move-later'
  | 'move-earlier'
  | 'clear-dates'
  | 'complete'
  | 'uncomplete'

export function Keycaps({
  keys,
  className
}: {
  keys: string[]
  className?: string
}): React.JSX.Element {
  return (
    <span aria-hidden="true" className={cn('inline-flex shrink-0 items-center gap-0.5', className)}>
      {keys.map((key) => (
        // Same keycap as the calendar detail cards' action bar.
        <Kbd
          key={key}
          className="h-[18px] min-w-[18px] border border-border bg-popover text-[11px]"
        >
          {key}
        </Kbd>
      ))}
    </span>
  )
}

interface TimelineActionPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  page: TimelinePanelPage
  onPageChange: (page: TimelinePanelPage) => void
  task: Task | null
  taskColor: string
  projectName: string
  projects: readonly Project[]
  weekStartsOn: 0 | 1
  onAction: (action: TimelineTaskAction) => void
  onSetDate: (field: 'start' | 'due', date: string | null) => void
  onMoveToProject: (projectId: string) => void
  /** Called instead of Radix's own focus return, so focus lands on the grid. */
  onCloseAutoFocus: () => void
  /** The trigger: the "Actions" hint in the action bar. */
  children: React.ReactNode
}

const ITEM_CLASS =
  'h-8 gap-2.5 rounded-[5px] px-2 text-[13px] data-[selected=true]:bg-accent data-[selected=true]:text-foreground [&_svg]:size-4 [&_svg]:text-muted-foreground'

function ActionItem({
  value,
  icon,
  label,
  keys,
  onSelect
}: {
  value: string
  icon: React.ReactNode
  label: string
  keys?: string[]
  onSelect: () => void
}): React.JSX.Element {
  return (
    <CommandItem value={value} keywords={[label]} onSelect={onSelect} className={ITEM_CLASS}>
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {keys && <Keycaps keys={keys} />}
    </CommandItem>
  )
}

/**
 * Raycast-style action panel for the selected task. Every action also has a
 * direct key on the timeline, shown beside it so the panel teaches them.
 */
export function TimelineActionPanel({
  open,
  onOpenChange,
  page,
  onPageChange,
  task,
  taskColor,
  projectName,
  projects,
  weekStartsOn,
  onAction,
  onSetDate,
  onMoveToProject,
  onCloseAutoFocus,
  children
}: TimelineActionPanelProps): React.JSX.Element {
  const { t } = useT('calendar')
  const [search, setSearch] = useState('')

  const goTo = (next: TimelinePanelPage): void => {
    setSearch('')
    onPageChange(next)
  }

  const run = (action: TimelineTaskAction): void => {
    onOpenChange(false)
    onAction(action)
  }

  const hasDates = Boolean(task?.startDate || task?.dueDate)
  const isCompleted = Boolean(task?.completedAt)
  const dateField = page === 'start' ? 'start' : 'due'
  const selectedDate = page === 'start' ? task?.startDate : task?.dueDate

  return (
    <Popover
      open={open && task !== null}
      onOpenChange={(next) => {
        if (!next) setSearch('')
        onOpenChange(next)
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        // The calendar detail card's shell, so the panel reads as its sibling.
        className="w-[26rem] overflow-hidden rounded-lg border-border p-0 shadow-[0_1px_2px_rgba(0,0,0,0.06),0_12px_32px_rgba(0,0,0,0.12)] dark:shadow-[0_0_0_1px_rgba(0,0,0,0.4),0_16px_40px_rgba(0,0,0,0.55)]"
        data-testid="timeline-action-panel"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onCloseAutoFocus()
        }}
      >
        {task && (
          <Command
            loop
            className="rounded-lg"
            onKeyDown={(event) => {
              if (
                page !== 'root' &&
                (event.key === 'Escape' || (event.key === 'Backspace' && search === ''))
              ) {
                event.preventDefault()
                event.stopPropagation()
                goTo('root')
              }
            }}
          >
            <CalendarCardHeader
              dotStyle={{ backgroundColor: taskColor }}
              label={
                <>
                  {t('timeline.actions.task')} · {projectName}
                  {page !== 'root' && ` · ${t(`timeline.actions.page.${page}`)}`}
                </>
              }
            />
            <div className="flex h-10 items-center gap-2 border-t border-border/70 px-3.5">
              <span className="max-w-[45%] shrink-0 truncate text-[13px] font-semibold text-foreground">
                {task.title || t('timeline.untitled')}
              </span>
              <CommandPrimitive.Input
                autoFocus
                value={search}
                onValueChange={setSearch}
                placeholder={
                  page === 'project'
                    ? t('timeline.actions.search-projects')
                    : t('timeline.actions.search')
                }
                className="h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
              />
            </div>

            {page === 'root' && (
              <CommandList className="max-h-[22rem] p-1.5">
                <CommandEmpty className="py-6 text-center text-[13px] text-text-tertiary">
                  {t('timeline.actions.empty')}
                </CommandEmpty>
                <CommandGroup className="p-0">
                  <ActionItem
                    value="open"
                    icon={<ArrowRight />}
                    label={t('timeline.actions.open')}
                    keys={['↵']}
                    onSelect={() => run('open')}
                  />
                  <ActionItem
                    value="open-in-tasks"
                    icon={<ArrowUpRight />}
                    label={t('timeline.actions.open-in-tasks')}
                    keys={[modifierKey, '↵']}
                    onSelect={() => run('open-in-tasks')}
                  />
                </CommandGroup>
                <CommandGroup
                  heading={t('timeline.actions.schedule')}
                  className="p-0 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-text-tertiary"
                >
                  <ActionItem
                    value="set-start"
                    icon={<Calendar />}
                    label={t('timeline.actions.set-start')}
                    keys={['S']}
                    onSelect={() => goTo('start')}
                  />
                  <ActionItem
                    value="set-due"
                    icon={<Clock />}
                    label={t('timeline.actions.set-due')}
                    keys={['D']}
                    onSelect={() => goTo('due')}
                  />
                  {hasDates && (
                    <>
                      <ActionItem
                        value="move-later"
                        icon={<ArrowRight />}
                        label={t('timeline.actions.move-later')}
                        keys={['W']}
                        onSelect={() => run('move-later')}
                      />
                      <ActionItem
                        value="move-earlier"
                        icon={<ArrowLeft />}
                        label={t('timeline.actions.move-earlier')}
                        keys={['⇧', 'W']}
                        onSelect={() => run('move-earlier')}
                      />
                      <ActionItem
                        value="clear-dates"
                        icon={<Eraser />}
                        label={t('timeline.actions.clear-dates')}
                        keys={['⌫']}
                        onSelect={() => run('clear-dates')}
                      />
                    </>
                  )}
                </CommandGroup>
                <CommandGroup
                  heading={t('timeline.actions.task')}
                  className="p-0 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-text-tertiary"
                >
                  <ActionItem
                    value={isCompleted ? 'uncomplete' : 'complete'}
                    icon={isCompleted ? <Circle /> : <CheckCircle />}
                    label={
                      isCompleted
                        ? t('timeline.actions.uncomplete')
                        : t('timeline.actions.complete')
                    }
                    keys={['C']}
                    onSelect={() => run(isCompleted ? 'uncomplete' : 'complete')}
                  />
                  <ActionItem
                    value="change-project"
                    icon={<FolderInput />}
                    label={t('timeline.actions.change-project')}
                    keys={['P']}
                    onSelect={() => goTo('project')}
                  />
                </CommandGroup>
              </CommandList>
            )}

            {page === 'project' && (
              <CommandList className="max-h-[22rem] p-1.5">
                <CommandEmpty className="py-6 text-center text-[13px] text-text-tertiary">
                  {t('timeline.actions.no-projects')}
                </CommandEmpty>
                {projects
                  .filter((project) => !project.isArchived)
                  .map((project) => (
                    <CommandItem
                      key={project.id}
                      value={project.id}
                      keywords={[project.name]}
                      onSelect={() => {
                        onOpenChange(false)
                        onMoveToProject(project.id)
                      }}
                      className={ITEM_CLASS}
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center">
                        <span
                          className="size-2 rounded-[2px]"
                          style={{ backgroundColor: project.color }}
                        />
                      </span>
                      <span className="flex-1 truncate">{project.name}</span>
                      {project.id === task.projectId && (
                        <CornerDownLeft className="text-text-tertiary" aria-hidden="true" />
                      )}
                    </CommandItem>
                  ))}
              </CommandList>
            )}

            {(page === 'start' || page === 'due') && (
              <div className="p-2">
                <DatePickerCalendar
                  selected={selectedDate ?? undefined}
                  weekStartsOn={weekStartsOn}
                  onSelect={(date) => {
                    onOpenChange(false)
                    onSetDate(dateField, date ? toLocalDateString(date) : null)
                  }}
                  onTodayClick={() => {
                    onOpenChange(false)
                    onSetDate(dateField, toLocalDateString(new Date()))
                  }}
                />
                {selectedDate && (
                  <CommandList className="p-0 pt-1">
                    <ActionItem
                      value="clear-field"
                      icon={<Eraser />}
                      label={t(`timeline.actions.clear-${dateField}`)}
                      onSelect={() => {
                        onOpenChange(false)
                        onSetDate(dateField, null)
                      }}
                    />
                  </CommandList>
                )}
              </div>
            )}
          </Command>
        )}
      </PopoverContent>
    </Popover>
  )
}
