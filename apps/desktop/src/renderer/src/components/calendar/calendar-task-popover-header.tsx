import type { ReactNode } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Check, ExternalLink } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { CARD_ICON_BUTTON_CLASS, CalendarCardHeader } from './calendar-card'

export interface CalendarTaskPopoverHeaderTask {
  id: string
  title: string
  completedAt: string | null
  parentId: string | null
}

export interface CalendarTaskPopoverHeaderProps {
  task: CalendarTaskPopoverHeaderTask
  parentTitle: string | null
  projectName: string
  onToggleComplete: () => void
  onOpenTask: () => void
  /** Overflow menu trigger for the less common actions. */
  menu?: ReactNode
}

export function CalendarTaskPopoverHeader({
  task,
  parentTitle,
  projectName,
  onToggleComplete,
  onOpenTask,
  menu
}: CalendarTaskPopoverHeaderProps): React.JSX.Element {
  const { t } = useT('calendar')
  const isDone = !!task.completedAt
  const kind = t('task-popover.kind')

  return (
    <>
      <CalendarCardHeader
        dotStyle={{ backgroundColor: 'var(--cal-green-rail)' }}
        label={projectName ? `${kind} · ${projectName}` : kind}
        actions={
          <>
            <button
              type="button"
              className={CARD_ICON_BUTTON_CLASS}
              aria-label={t('task-popover.open-task')}
              title={t('task-popover.open-task')}
              onClick={onOpenTask}
            >
              <ExternalLink className="size-3.5" />
            </button>
            {menu}
          </>
        }
      />
      <div className="flex flex-col gap-1 px-3.5 pb-3">
        {task.parentId && parentTitle && (
          <div
            data-testid="parent-breadcrumb"
            className="truncate ps-7 text-xs text-muted-foreground"
          >
            ↳ {parentTitle}
          </div>
        )}
        <div className="flex items-start gap-2.5">
          <button
            type="button"
            role="checkbox"
            aria-checked={isDone}
            aria-label={isDone ? t('task-popover.mark-not-done') : t('task-popover.mark-done')}
            data-testid="task-popover-complete"
            onClick={onToggleComplete}
            className={cn(
              'mt-0.5 grid size-[18px] shrink-0 place-content-center rounded-[5px] border-[1.5px] border-(--cal-green-rail) outline-none',
              'transition-colors hover:bg-(--cal-green-surface) focus-visible:ring-2 focus-visible:ring-(--tint-ring)',
              isDone && 'bg-(--cal-green-rail) text-white hover:bg-(--cal-green-rail)'
            )}
          >
            {isDone && <Check className="size-3" />}
          </button>
          <span
            className={cn(
              'min-w-0 flex-1 text-[17px] leading-[22px] font-semibold tracking-[-0.01em] text-(--cal-ink) line-clamp-3',
              isDone && 'text-muted-foreground line-through'
            )}
            title={task.title}
          >
            {task.title}
          </span>
        </div>
      </div>
    </>
  )
}
