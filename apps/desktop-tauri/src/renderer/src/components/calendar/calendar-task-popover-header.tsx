import type { ReactNode } from 'react'
import { useT } from '@memry/i18n/renderer'
import { ExternalLink } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { CARD_ICON_BUTTON_CLASS, CalendarCardHeader } from './calendar-card'
import { CalendarTaskStatus } from './calendar-task-status'

export interface CalendarTaskPopoverHeaderTask {
  id: string
  title: string
  completedAt: string | null
  projectId: string
  statusId?: string | null
  parentId: string | null
}

export interface CalendarTaskPopoverHeaderProps {
  task: CalendarTaskPopoverHeaderTask
  parentTitle: string | null
  projectName: string
  onOpenTask: () => void
  /** Opens Tasks zoomed into the parent's branch, with this subtask open. */
  onOpenParent: () => void
  /** Overflow menu trigger for the less common actions. */
  menu?: ReactNode
}

export function CalendarTaskPopoverHeader({
  task,
  parentTitle,
  projectName,
  onOpenTask,
  onOpenParent,
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
          <button
            type="button"
            data-testid="parent-breadcrumb"
            onClick={onOpenParent}
            className="w-fit max-w-full truncate ps-7 text-start text-xs text-muted-foreground hover:text-foreground hover:underline focus-visible:underline focus-visible:outline-none"
          >
            ↳ {parentTitle}
          </button>
        )}
        <div className="flex items-start gap-2.5">
          <span
            className="mt-0.5 grid size-[22px] shrink-0 place-content-center"
            data-testid="task-popover-status"
          >
            <CalendarTaskStatus
              taskId={task.id}
              projectId={task.projectId}
              statusId={task.statusId ?? null}
              isCompleted={isDone}
              size="lg"
            />
          </span>
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
