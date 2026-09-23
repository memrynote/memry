import { useT } from '@memry/i18n/renderer'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { CalendarCardSection } from './calendar-card'

export interface CalendarTaskPopoverSubtask {
  id: string
  title: string
  completedAt: string | null
}

export interface CalendarTaskPopoverSubtasksProps {
  subtasks: CalendarTaskPopoverSubtask[]
  onToggleSubtask: (subtaskId: string) => void
}

export function CalendarTaskPopoverSubtasks({
  subtasks,
  onToggleSubtask
}: CalendarTaskPopoverSubtasksProps): React.JSX.Element | null {
  const { t } = useT('calendar')
  if (subtasks.length === 0) return null

  const doneCount = subtasks.filter((s) => !!s.completedAt).length
  const progress = Math.round((doneCount / subtasks.length) * 100)

  return (
    <CalendarCardSection className="px-1.5 pt-2.5 pb-2">
      <div className="flex items-center gap-2.5 px-2 pb-1.5">
        <span className="text-[11px] font-medium tracking-[0.04em] text-muted-foreground uppercase">
          {t('task-popover.subtasks-prefix')}
        </span>
        <span
          role="progressbar"
          aria-label={t('task-popover.subtasks-counter', {
            done: doneCount,
            total: subtasks.length
          })}
          aria-valuemin={0}
          aria-valuemax={subtasks.length}
          aria-valuenow={doneCount}
          className="h-[3px] flex-1 overflow-hidden rounded-full bg-foreground/10"
        >
          <span
            className="block h-full rounded-full bg-(--cal-green-rail) transition-[width] duration-200"
            style={{ width: `${progress}%` }}
          />
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {doneCount} / {subtasks.length}
        </span>
      </div>
      <ul className="max-h-[168px] overflow-y-auto">
        {subtasks.map((s) => {
          const done = !!s.completedAt
          return (
            <li key={s.id}>
              <label className="flex h-7 cursor-pointer items-center gap-2.5 rounded-[5px] px-2 hover:bg-accent">
                <Checkbox
                  checked={done}
                  onCheckedChange={() => onToggleSubtask(s.id)}
                  aria-label={done ? t('task-popover.mark-not-done') : t('task-popover.mark-done')}
                  className="size-3.5 rounded-[4px]"
                />
                <span
                  className={cn(
                    'min-w-0 truncate text-[13px] text-foreground',
                    done && 'text-muted-foreground line-through'
                  )}
                >
                  {s.title}
                </span>
              </label>
            </li>
          )
        })}
      </ul>
    </CalendarCardSection>
  )
}
