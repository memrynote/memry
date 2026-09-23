import { useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'
import { useTasksOptional } from '@/contexts/tasks'
import type { Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { CalendarDays } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { isWeekend, parseLocalDate, toLocalDateString } from './date-utils'
import {
  buildTimelineGroups,
  getMonthDays,
  type TimelineBar,
  type TimelineSchedule
} from './timeline-model'
import type { AnchorRect } from './types'

const NO_TASKS: Task[] = []
const NO_PROJECTS: Project[] = []

function barColumns(bar: TimelineBar): React.CSSProperties {
  return { gridColumn: `${bar.columnStart + 2} / ${bar.columnEnd + 3}`, gridRow: 1 }
}

interface CalendarTimelineViewProps {
  anchorDate: string
  selectedTaskId: string | null
  onSelectTask?: (taskId: string, rect: AnchorRect) => void
}

export function CalendarTimelineView({
  anchorDate,
  selectedTaskId,
  onSelectTask
}: CalendarTimelineViewProps): React.JSX.Element {
  const { t, i18n } = useT('calendar')
  const tasksContext = useTasksOptional()
  const tasks = tasksContext?.tasks ?? NO_TASKS
  const projects = tasksContext?.projects ?? NO_PROJECTS

  const days = useMemo(() => getMonthDays(anchorDate), [anchorDate])
  const groups = useMemo(() => buildTimelineGroups(tasks, projects, days), [tasks, projects, days])
  const todayColumn = days.indexOf(toLocalDateString(new Date()))
  const gridTemplateColumns = `minmax(10rem, 16rem) repeat(${days.length}, minmax(1.75rem, 1fr))`

  const weekdayFormat = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { weekday: 'narrow' }),
    [i18n.language]
  )
  const windowYear = days[0].slice(0, 4)
  const formatDay = (day: string): string =>
    new Intl.DateTimeFormat(i18n.language, {
      month: 'short',
      day: 'numeric',
      year: day.startsWith(windowYear) ? undefined : 'numeric'
    }).format(parseLocalDate(day))
  const describeSchedule = (schedule: TimelineSchedule): string => {
    switch (schedule.kind) {
      case 'span':
        return t('timeline.span', {
          start: formatDay(schedule.startDate),
          end: formatDay(schedule.dueDate)
        })
      case 'due':
        return t('timeline.due', { date: formatDay(schedule.dueDate) })
      case 'start':
        return t('timeline.starts', { date: formatDay(schedule.startDate) })
    }
  }

  if (groups.length === 0) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
        data-testid="calendar-view"
        data-view="timeline"
      >
        <CalendarDays className="size-5 text-text-tertiary" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">{t('timeline.empty-title')}</p>
        <p className="max-w-sm text-xs text-text-secondary">{t('timeline.empty-body')}</p>
      </div>
    )
  }

  return (
    <div
      className="h-full overflow-auto"
      data-calendar-scroll
      data-testid="calendar-view"
      data-view="timeline"
    >
      <div
        className="relative w-full min-w-max pb-6"
        role="region"
        aria-label={t('timeline.label')}
      >
        <div
          aria-hidden="true"
          className="sticky top-0 z-20 grid border-b border-border bg-background"
          style={{ gridTemplateColumns }}
        >
          <div className="sticky start-0 z-10 flex items-end bg-background ps-4 pe-2 pb-1.5 text-xs font-medium text-text-tertiary">
            {t('timeline.tasks-column')}
          </div>
          {days.map((day, index) => (
            <div
              key={day}
              className={cn(
                'flex flex-col items-center gap-0.5 py-1.5 text-center',
                isWeekend(day) ? 'text-text-tertiary' : 'text-text-secondary'
              )}
            >
              <span className="text-[10px] leading-none">
                {weekdayFormat.format(parseLocalDate(day))}
              </span>
              <span
                className={cn(
                  'inline-flex size-5 items-center justify-center rounded-full text-xs tabular-nums',
                  index === todayColumn && 'bg-tint font-semibold text-tint-foreground'
                )}
              >
                {Number(day.slice(8))}
              </span>
            </div>
          ))}
        </div>

        <div className="relative">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 grid"
            style={{ gridTemplateColumns }}
          >
            {days.map((day, index) => (
              <div
                key={day}
                style={{ gridColumn: index + 2, gridRow: 1 }}
                className={cn(
                  index === todayColumn ? 'bg-tint/10' : isWeekend(day) && 'bg-surface/70'
                )}
              />
            ))}
          </div>

          {groups.map((group) => (
            <section key={group.projectId} aria-label={group.name} className="pt-2">
              <div className="relative grid h-8 items-center" style={{ gridTemplateColumns }}>
                <div className="sticky start-0 z-10 flex h-full min-w-0 items-center gap-2 bg-background ps-4 pe-2">
                  <span
                    aria-hidden="true"
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: group.color }}
                  />
                  <h3 className="truncate text-[13px] font-medium text-foreground">{group.name}</h3>
                  <span className="shrink-0 text-[11px] tabular-nums text-text-tertiary">
                    {t('timeline.task-count', { count: group.rows.length })}
                  </span>
                </div>
                <div
                  aria-hidden="true"
                  data-testid="timeline-project-bar"
                  className={cn(
                    'relative mx-0.5 h-1 rounded-full opacity-40',
                    group.bar.continuesBefore && 'ms-0 rounded-s-none',
                    group.bar.continuesAfter && 'me-0 rounded-e-none'
                  )}
                  style={{ ...barColumns(group.bar), backgroundColor: group.color }}
                />
              </div>

              <ul>
                {group.rows.map((row) => {
                  const label = `${row.title}, ${describeSchedule(row.schedule)}`
                  const isSelected = row.taskId === selectedTaskId
                  return (
                    <li
                      key={row.taskId}
                      className="group relative grid h-8 items-center"
                      style={{ gridTemplateColumns }}
                    >
                      <button
                        type="button"
                        aria-label={label}
                        title={label}
                        aria-haspopup="dialog"
                        aria-expanded={isSelected}
                        data-testid="timeline-task-row"
                        onClick={(event) => {
                          const rect = event.currentTarget.getBoundingClientRect()
                          onSelectTask?.(row.taskId, {
                            x: rect.left,
                            y: rect.top,
                            width: rect.width,
                            height: rect.height
                          })
                        }}
                        className={cn(
                          'absolute inset-0 transition-colors duration-100 ease-out',
                          'hover:bg-surface-active/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                          isSelected && 'bg-surface-active/60'
                        )}
                      />
                      <span
                        className={cn(
                          'pointer-events-none sticky start-0 z-10 flex h-full min-w-0 items-center bg-background ps-8 pe-2',
                          'transition-colors duration-100 ease-out group-hover:bg-surface-active',
                          isSelected && 'bg-surface-active'
                        )}
                      >
                        <span className="truncate text-[13px] text-text-secondary">
                          {row.title}
                        </span>
                      </span>
                      {row.schedule.kind === 'span' ? (
                        <div
                          aria-hidden="true"
                          data-testid="timeline-task-bar"
                          className={cn(
                            'pointer-events-none relative mx-0.5 h-5 rounded-md opacity-80',
                            row.bar.continuesBefore && 'ms-0 rounded-s-none',
                            row.bar.continuesAfter && 'me-0 rounded-e-none'
                          )}
                          style={{ ...barColumns(row.bar), backgroundColor: group.color }}
                        />
                      ) : (
                        <div
                          aria-hidden="true"
                          data-testid="timeline-task-marker"
                          data-kind={row.schedule.kind}
                          className="pointer-events-none relative size-2.5 rotate-45 justify-self-center rounded-[2px] border-2"
                          style={{
                            ...barColumns(row.bar),
                            borderColor: group.color,
                            backgroundColor:
                              row.schedule.kind === 'due' ? group.color : 'transparent'
                          }}
                        />
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

export default CalendarTimelineView
