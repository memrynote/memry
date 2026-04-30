import { useT } from '@memry/i18n/renderer'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'

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

  return (
    <div className="px-3 py-2 border-t">
      <div className="text-xs text-muted-foreground mb-1.5">
        {t('task-popover.subtasks-prefix')} ·{' '}
        <span>
          {t('task-popover.subtasks-counter', { done: doneCount, total: subtasks.length })}
        </span>
      </div>
      <ul className="space-y-1">
        {subtasks.map((s) => {
          const done = !!s.completedAt
          return (
            <li key={s.id} className="flex items-center gap-2">
              <Checkbox
                checked={done}
                onCheckedChange={() => onToggleSubtask(s.id)}
                aria-label={done ? t('task-popover.mark-not-done') : t('task-popover.mark-done')}
              />
              <span className={cn('text-sm', done && 'line-through text-muted-foreground')}>
                {s.title}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
