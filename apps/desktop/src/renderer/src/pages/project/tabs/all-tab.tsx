import { useMemo, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { useTasksContext } from '@/contexts/tasks'
import { useTabViewState } from '@/hooks/use-tab-view-state'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  buildAllRows,
  daysLeft,
  sortAllRows,
  type AllRow,
  type AllRowsInput,
  type AllSort,
  type AllSortKey
} from '../all-rows'
import { PROJECT_VIEW_STATE_KEYS, parseAllSort } from '../project-view-state'
import { EventRow } from '../rows/event-row'
import { NoteRow } from '../rows/note-row'
import { TaskRow } from '../rows/task-row'
import type { HubHandlers } from './hub-handlers'

const DUE_SOON_DAYS = 3

export type AllTabSource = Omit<AllRowsInput, 'now' | 'showDone'>

interface AllTabProps {
  source: AllTabSource
  showDone: boolean
  handlers: HubHandlers
}

const nextSort = (current: AllSort | null, key: AllSortKey): AllSort | null => {
  if (current?.key !== key) return { key, dir: 'asc' }
  return current.dir === 'asc' ? { key, dir: 'desc' } : null
}

const SortButton = ({
  label,
  sortKey,
  sort,
  onSort
}: {
  label: string
  sortKey: AllSortKey
  sort: AllSort | null
  onSort: (key: AllSortKey) => void
}): React.JSX.Element => {
  const active = sort?.key === sortKey
  const Arrow = sort?.dir === 'desc' ? ArrowDown : ArrowUp
  return (
    <button
      type="button"
      onClick={() => {
        onSort(sortKey)
      }}
      aria-sort={active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : undefined}
      className={cn(
        'flex items-center gap-1 text-xs font-semibold tracking-[0.02em] hover:text-foreground',
        active ? 'text-foreground' : 'text-muted-foreground'
      )}
    >
      {label}
      {active ? <Arrow className="size-3" aria-hidden="true" /> : null}
    </button>
  )
}

const DaysLeft = ({ row, now }: { row: AllRow; now: Date }): React.JSX.Element => {
  const { t } = useT('tasks')
  if (!row.due || row.isDone) return <span aria-hidden="true" />
  const days = daysLeft(row.due, now)
  if (days < 0) {
    return <span className="text-destructive">{t('projectHub.all.overdue', { count: -days })}</span>
  }
  return (
    <span
      className={cn(
        'rounded px-1.5 tabular-nums',
        days <= DUE_SOON_DAYS ? 'bg-tint-light text-tint-ink' : 'text-muted-foreground'
      )}
    >
      {t('projectHub.all.daysLeft', { count: days })}
    </span>
  )
}

/**
 * The project's All tab: notes with their tasks under them, loose tasks and events,
 * in the Overview's own rows so every list in the hub reads the same.
 */
export const AllTab = ({ source, showDone, handlers }: AllTabProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const { projects } = useTasksContext()
  const [sort, setSort] = useTabViewState<AllSort | null>({
    key: PROJECT_VIEW_STATE_KEYS.allSort,
    defaultValue: null,
    parse: parseAllSort
  })
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  const now = useMemo(() => new Date(), [])
  const rows = useMemo(() => {
    const built = buildAllRows({ ...source, now, showDone })
    return sort
      ? sortAllRows(built, sort)
      : built.filter((row) => !collapsed.has(row.parentNoteId ?? ''))
  }, [source, now, showDone, sort, collapsed])

  const toggleCollapsed = (noteId: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (!next.delete(noteId)) next.add(noteId)
      return next
    })
  }

  const renderRow = (row: AllRow): React.JSX.Element | null => {
    if (row.task) {
      const project = projects.find((p) => p.id === row.task?.projectId) ?? source.project
      return (
        <TaskRow
          task={row.task}
          project={project}
          onOpen={handlers.onOpenTask}
          onStatusChange={handlers.onStatusChange}
          onToggleComplete={handlers.onToggleComplete}
          onPriorityChange={handlers.onPriorityChange}
          showDue={false}
        />
      )
    }
    if (row.note) {
      return (
        <NoteRow
          note={row.note}
          onOpen={handlers.onOpenNote}
          onIconChange={handlers.onNoteIconChange}
        />
      )
    }
    return row.event ? <EventRow event={row.event} onOpen={handlers.onOpenEvent} /> : null
  }

  return (
    <div className="px-4 py-3 pb-6">
      <div className="mb-1 flex items-center border-b border-border/60 px-2 py-2">
        <div className="flex-1">
          <SortButton
            label={t('projectHub.all.columns.title')}
            sortKey="title"
            sort={sort}
            onSort={(key) => {
              setSort(nextSort(sort, key))
            }}
          />
        </div>
        <div className="flex w-24 shrink-0 justify-end">
          <SortButton
            label={t('projectHub.all.columns.daysLeft')}
            sortKey="due"
            sort={sort}
            onSort={(key) => {
              setSort(nextSort(sort, key))
            }}
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="px-2 py-1.5 text-[13px] text-muted-foreground">{t('projectHub.all.empty')}</p>
      ) : (
        <div role="list" className="space-y-px">
          {rows.map((row) => {
            const nested = !sort && row.parentNoteId !== null
            const hasChildren = !sort && row.taskSummary !== null
            return (
              <div
                key={row.key}
                className="flex items-center rounded-md transition-colors duration-150 hover:bg-muted"
              >
                {!sort ? (
                  <span className={cn('flex w-4 shrink-0 justify-center', nested && 'ms-4')}>
                    {hasChildren ? (
                      <button
                        type="button"
                        aria-expanded={!collapsed.has(row.id)}
                        aria-label={t(
                          collapsed.has(row.id)
                            ? 'projectHub.all.expand'
                            : 'projectHub.all.collapse',
                          { title: row.title }
                        )}
                        onClick={() => {
                          toggleCollapsed(row.id)
                        }}
                        className="text-muted-foreground/60 hover:text-foreground"
                      >
                        {collapsed.has(row.id) ? (
                          <ChevronRight className="size-3 rtl:rotate-180" aria-hidden="true" />
                        ) : (
                          <ChevronDown className="size-3" aria-hidden="true" />
                        )}
                      </button>
                    ) : null}
                  </span>
                ) : null}
                <div className="min-w-0 flex-1">{renderRow(row)}</div>
                <span className="flex w-24 shrink-0 justify-end pe-2 text-[11px]">
                  <DaysLeft row={row} now={now} />
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
