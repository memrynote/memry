import { useMemo, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { TFunction } from 'i18next'
import type { TaskActivityEntry } from '@memry/rpc/tasks'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription
} from '@/components/ui/sheet'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { TASK_ACTIVITY_RETENTION_DAYS } from '@memry/db-schema/schema/task-activity'
import { useTaskActivity } from '@/hooks/use-task-activity'
import { TaskActivityRow, actionLabel } from './task-activity-row'

const FILTERABLE_ACTIONS = [
  'created',
  'updated',
  'completed',
  'uncompleted',
  'moved',
  'deleted',
  'superseded'
] as const

const ALL = '__all__'

export interface TaskActivitySheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  taskId: string | null
  taskTitle: string
  language: string
}

/**
 * The full timeline.
 *
 * The drawer is 266px by default, which is not enough room for a filter plus
 * old → new on one line, so "Show all" opens here instead of expanding inline.
 * Rows are grouped by day so a burst of edits reads as one session.
 */
export function TaskActivitySheet({
  open,
  onOpenChange,
  taskId,
  taskTitle,
  language
}: TaskActivitySheetProps): React.JSX.Element {
  const { t } = useT('tasks')
  const [action, setAction] = useState<string>(ALL)

  const { entries, hasMore, isLoading, isFetchingNextPage, fetchNextPage, error } = useTaskActivity(
    {
      taskId,
      actions: action === ALL ? undefined : [action],
      enabled: open
    }
  )

  const groups = useMemo(() => groupByDay(entries, language, t), [entries, language, t])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-[420px] flex-col gap-0 sm:max-w-[420px]">
        <SheetHeader>
          <SheetTitle>{t('drawer.activityTitle', { title: taskTitle })}</SheetTitle>
          <SheetDescription>{t('drawer.activityDescription')}</SheetDescription>
        </SheetHeader>

        <div className="px-4 py-3">
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger aria-label={t('drawer.activityFilter')} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('drawer.activityFilterAll')}</SelectItem>
              {FILTERABLE_ACTIONS.map((value) => (
                <SelectItem key={value} value={value}>
                  {actionLabel(value, t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <ScrollArea className="flex-1 px-4">
          {isLoading && (
            <p className="py-4 text-[12px] text-text-tertiary">{t('drawer.activityLoading')}</p>
          )}
          {error && (
            <p className="py-4 text-[12px] text-destructive">{t('drawer.activityError')}</p>
          )}
          {!isLoading && !error && entries.length === 0 && (
            <p className="py-4 text-[12px] text-text-tertiary">{t('drawer.activityEmpty')}</p>
          )}

          {groups.map((group, index) => (
            // Keyed by position, not label: a row that arrives with an
            // unparseable timestamp groups under an empty label, and two of
            // those would collide on a label key.
            <div key={`${index}-${group.label}`} className="flex flex-col">
              <span className="sticky top-0 bg-background py-2 text-[11px] font-medium uppercase leading-3.5 text-text-tertiary [letter-spacing:0.05em]">
                {group.label}
              </span>
              {group.entries.map((entry) => (
                <TaskActivityRow key={entry.id} entry={entry} language={language} />
              ))}
            </div>
          ))}

          {hasMore && (
            <Button
              variant="ghost"
              size="sm"
              className="my-2 w-full"
              onClick={fetchNextPage}
              disabled={isFetchingNextPage}
            >
              {t('drawer.activityMore')}
            </Button>
          )}
        </ScrollArea>

        <p className="px-4 py-3 text-[11px] leading-3.5 text-text-tertiary/70">
          {t('drawer.activityRetention', { days: TASK_ACTIVITY_RETENTION_DAYS })}
        </p>
      </SheetContent>
    </Sheet>
  )
}

interface DayGroup {
  label: string
  entries: TaskActivityEntry[]
}

function groupByDay(
  entries: TaskActivityEntry[],
  language: string,
  t: TFunction<'tasks'>
): DayGroup[] {
  const dayFormatter = new Intl.DateTimeFormat(language, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
  const today = new Date()
  const yesterday = new Date(today.getTime() - 86_400_000)

  const groups: DayGroup[] = []
  for (const entry of entries) {
    const date = new Date(entry.createdAt)
    const label = Number.isNaN(date.getTime())
      ? t('drawer.activityUnknownDate')
      : isSameDay(date, today)
        ? t('drawer.activityToday')
        : isSameDay(date, yesterday)
          ? t('drawer.activityYesterday')
          : dayFormatter.format(date)

    const last = groups[groups.length - 1]
    if (last && last.label === label) last.entries.push(entry)
    else groups.push({ label, entries: [entry] })
  }
  return groups
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}
