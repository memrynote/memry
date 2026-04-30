import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useCallback } from 'react'
import { useT } from '@memry/i18n/renderer'
import { computePopoverPosition } from './popover-position'
import { CalendarTaskPopoverHeader } from './calendar-task-popover-header'
import { CalendarTaskPopoverMeta } from './calendar-task-popover-meta'
import { CalendarTaskPopoverSubtasks } from './calendar-task-popover-subtasks'
import { CalendarTaskPopoverActions } from './calendar-task-popover-actions'
import { useTask } from '@/hooks/use-task'
import { useSubtasks } from '@/hooks/use-subtasks'
import { useProject } from '@/hooks/use-project'
import { useTabs } from '@/contexts/tabs'
import { tasksService } from '@/services/tasks-service'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import type { SnoozeTarget } from '@/lib/snooze-options'
import type { AnchorRect } from './types'
import type { RepeatConfig } from '@/services/tasks-service'

const log = createLogger('CalendarTaskPopover')

export interface CalendarTaskPopoverProps {
  item: CalendarProjectionItem
  anchorRect: AnchorRect
  onDismiss: () => void
}

export function CalendarTaskPopover({
  item,
  anchorRect,
  onDismiss
}: CalendarTaskPopoverProps): React.JSX.Element | null {
  const { data: task } = useTask(item.sourceId)
  const { data: subtasks = [] } = useSubtasks(item.sourceId)
  const { data: project } = useProject(task?.projectId ?? null)
  const { data: parentTask } = useTask(task?.parentId ?? null)
  const { openTab } = useTabs()
  const { t } = useT('calendar')

  const isCompleted = !!task?.completedAt

  const handleToggleComplete = useCallback((): void => {
    if (!task) return
    const promise = task.completedAt
      ? tasksService.uncomplete(task.id)
      : tasksService.complete({ id: task.id }).then(() => {
          setTimeout(onDismiss, 600)
        })
    promise.catch((err: unknown) => {
      log.error(
        'toggle complete failed:',
        extractErrorMessage(err, t('task-popover.errors.could-not-save'))
      )
    })
  }, [task, onDismiss, t])

  const handleToggleSubtask = useCallback(
    (subtaskId: string): void => {
      const sub = subtasks.find((s) => s.id === subtaskId)
      if (!sub) return
      const promise = sub.completedAt
        ? tasksService.uncomplete(subtaskId)
        : tasksService.complete({ id: subtaskId })
      promise.catch((err: unknown) => {
        log.error(
          'subtask toggle failed:',
          extractErrorMessage(err, t('task-popover.errors.could-not-save'))
        )
      })
    },
    [subtasks, t]
  )

  const handleSnooze = useCallback(
    (target: SnoozeTarget): void => {
      if (!task) return
      tasksService
        .update({ id: task.id, dueDate: target.dueDate, dueTime: target.dueTime })
        .then(() => onDismiss())
        .catch((err: unknown) => {
          log.error(
            'snooze failed:',
            extractErrorMessage(err, t('task-popover.errors.could-not-snooze'))
          )
        })
    },
    [task, onDismiss, t]
  )

  const handleRemoveDueDate = useCallback((): void => {
    if (!task) return
    tasksService
      .update({ id: task.id, dueDate: null, dueTime: null })
      .then(() => onDismiss())
      .catch((err: unknown) => {
        log.error(
          'remove due date failed:',
          extractErrorMessage(err, t('task-popover.errors.could-not-remove-due-date'))
        )
      })
  }, [task, onDismiss, t])

  const handleOpenTask = useCallback(() => {
    openTab({
      type: 'tasks',
      title: 'Tasks',
      icon: 'CheckSquare',
      path: '/tasks',
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false,
      viewState: { openTaskId: item.sourceId }
    })
    onDismiss()
  }, [openTab, item.sourceId, onDismiss])

  const handleOverflow = useCallback((_anchor: HTMLElement) => {
    // Overflow menu (Delete / Duplicate / Move to project / Copy link) is a
    // follow-up PR. Header still renders the trigger so the layout is final;
    // clicking it is intentionally a no-op until that PR lands.
  }, [])

  const handleOpenSourceNote = useCallback((): void => {
    if (!task?.sourceNoteId) return
    window.api.notes
      .get(task.sourceNoteId)
      .then((note) => {
        if (!note) return
        openTab({
          type: 'note',
          title: note.title ?? note.path,
          icon: 'FileText',
          path: note.path,
          entityId: note.id,
          isPinned: false,
          isModified: false,
          isPreview: true,
          isDeleted: false
        })
        onDismiss()
      })
      .catch((err: unknown) => {
        log.error(
          'open source note failed:',
          extractErrorMessage(err, t('task-popover.errors.could-not-open-note'))
        )
      })
  }, [task, openTab, onDismiss, t])

  const handlePickDateTime = useCallback(() => {
    // Custom date-time picker dialog is a follow-up PR. For now, route to the
    // existing TaskDetailDrawer where the user can change due date/time fully.
    if (task) {
      openTab({
        type: 'tasks',
        title: 'Tasks',
        icon: 'CheckSquare',
        path: '/tasks',
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false,
        viewState: { openTaskId: task.id }
      })
    }
    onDismiss()
  }, [task, openTab, onDismiss])

  if (!task) return null

  const { top, left } = computePopoverPosition(anchorRect, { estimatedHeight: 320 })

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onDismiss()
      }}
      modal={false}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          data-testid="calendar-task-popover"
          aria-label={task.title}
          aria-describedby={undefined}
          onPointerDownOutside={(e) => {
            const target = e.target as HTMLElement | null
            if (target?.closest('[data-radix-popper-content-wrapper]')) {
              e.preventDefault()
            }
          }}
          onInteractOutside={(e) => {
            const target = e.target as HTMLElement | null
            if (target?.closest('[data-radix-popper-content-wrapper]')) {
              e.preventDefault()
            }
          }}
          className="fixed z-50 rounded-md border bg-popover text-popover-foreground shadow-md outline-none"
          style={{ top, left, width: 340 }}
        >
          <DialogPrimitive.Title className="sr-only">
            {t('task-popover.title-fallback')}
          </DialogPrimitive.Title>
          <CalendarTaskPopoverHeader
            task={task}
            parentTitle={parentTask?.title ?? null}
            onToggleComplete={handleToggleComplete}
            onOverflow={handleOverflow}
          />
          <CalendarTaskPopoverMeta
            task={task}
            projectName={project?.name ?? ''}
            statusLabel={null}
            tags={task.tags ?? []}
            repeatSummary={summarizeRepeat(task.repeatConfig, t)}
            description={task.description}
            isCompleted={isCompleted}
          />
          <CalendarTaskPopoverSubtasks subtasks={subtasks} onToggleSubtask={handleToggleSubtask} />
          <CalendarTaskPopoverActions
            isCompleted={isCompleted}
            isAllDay={!task.dueTime}
            sourceNoteId={task.sourceNoteId}
            onOpenTask={handleOpenTask}
            onOpenSourceNote={handleOpenSourceNote}
            onSnooze={handleSnooze}
            onRemoveDueDate={handleRemoveDueDate}
            onPickDateTime={handlePickDateTime}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function summarizeRepeat(cfg: RepeatConfig | null, t: (key: string) => string): string | null {
  if (!cfg) return null
  switch (cfg.frequency) {
    case 'daily':
      return t('task-popover.repeats-daily')
    case 'weekly':
      return t('task-popover.repeats-weekly')
    case 'monthly':
      return t('task-popover.repeats-monthly')
    case 'yearly':
      return t('task-popover.repeats-yearly')
    default:
      return t('task-popover.repeats')
  }
}
