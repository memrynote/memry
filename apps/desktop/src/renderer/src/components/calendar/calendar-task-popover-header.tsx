import { useT } from '@memry/i18n/renderer'
import { MoreHorizontal } from '@/lib/icons'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface CalendarTaskPopoverHeaderTask {
  id: string
  title: string
  completedAt: string | null
  parentId: string | null
}

export interface CalendarTaskPopoverHeaderProps {
  task: CalendarTaskPopoverHeaderTask
  parentTitle: string | null
  onToggleComplete: () => void
  onOverflow: (anchor: HTMLElement) => void
}

export function CalendarTaskPopoverHeader({
  task,
  parentTitle,
  onToggleComplete,
  onOverflow
}: CalendarTaskPopoverHeaderProps): React.JSX.Element {
  const { t } = useT('calendar')
  const isDone = !!task.completedAt

  return (
    <div className="flex items-start gap-2 ps-3 pe-2 py-2 border-b">
      <div className="flex-1 min-w-0">
        {task.parentId && parentTitle && (
          <div data-testid="parent-breadcrumb" className="text-xs text-muted-foreground truncate">
            ↳ {parentTitle}
          </div>
        )}
        <div className="flex items-start gap-2">
          <Checkbox
            checked={isDone}
            onCheckedChange={onToggleComplete}
            aria-label={isDone ? t('task-popover.mark-not-done') : t('task-popover.mark-done')}
            className="mt-1"
          />
          <span
            className={cn(
              'text-sm font-medium leading-snug line-clamp-2',
              isDone && 'line-through text-muted-foreground'
            )}
          >
            {task.title}
          </span>
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t('task-popover.more-actions')}
        onClick={(e) => onOverflow(e.currentTarget)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>
    </div>
  )
}
