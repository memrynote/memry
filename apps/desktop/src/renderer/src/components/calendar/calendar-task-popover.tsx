import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useCallback } from 'react'
import { computePopoverPosition } from './popover-position'
import { CalendarTaskPopoverHeader } from './calendar-task-popover-header'
import { CalendarTaskPopoverMeta } from './calendar-task-popover-meta'
import { CalendarTaskPopoverSubtasks } from './calendar-task-popover-subtasks'
import { CalendarTaskPopoverActions } from './calendar-task-popover-actions'
import { useTask } from '@/hooks/use-task'
import { useSubtasks } from '@/hooks/use-subtasks'
import { useProject } from '@/hooks/use-project'
import { useDayPanel } from '@/contexts/day-panel-context'
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
  const { openForTask } = useDayPanel()
  const { openTab } = useTabs()

  const isCompleted = !!task?.completedAt

  const handleToggleComplete = useCallback(async () => {
    if (!task) return
    try {
      if (task.completedAt) {
        await tasksService.uncomplete(task.id)
      } else {
        await tasksService.complete({ id: task.id })
        setTimeout(onDismiss, 600)
      }
    } catch (err) {
      log.error('toggle complete failed:', extractErrorMessage(err, 'Could not save task'))
    }
  }, [task, onDismiss])

  const handleToggleSubtask = useCallback(
    async (subtaskId: string) => {
      const sub = subtasks.find((s) => s.id === subtaskId)
      if (!sub) return
      try {
        if (sub.completedAt) {
          await tasksService.uncomplete(subtaskId)
        } else {
          await tasksService.complete({ id: subtaskId })
        }
      } catch (err) {
        log.error('subtask toggle failed:', extractErrorMessage(err, 'Could not save subtask'))
      }
    },
    [subtasks]
  )

  const handleSnooze = useCallback(
    async (target: SnoozeTarget) => {
      if (!task) return
      try {
        await tasksService.update({
          id: task.id,
          dueDate: target.dueDate,
          dueTime: target.dueTime
        })
        onDismiss()
      } catch (err) {
        log.error('snooze failed:', extractErrorMessage(err, 'Could not snooze task'))
      }
    },
    [task, onDismiss]
  )

  const handleRemoveDueDate = useCallback(async () => {
    if (!task) return
    try {
      await tasksService.update({ id: task.id, dueDate: null, dueTime: null })
      onDismiss()
    } catch (err) {
      log.error('remove due date failed:', extractErrorMessage(err, 'Could not remove due date'))
    }
  }, [task, onDismiss])

  const handleOpenTask = useCallback(() => {
    openForTask(item.sourceId)
    onDismiss()
  }, [openForTask, item.sourceId, onDismiss])

  const handleOverflow = useCallback((_anchor: HTMLElement) => {
    // Overflow menu (Delete / Duplicate / Move to project / Copy link) is a
    // follow-up PR. Header still renders the trigger so the layout is final;
    // clicking it is intentionally a no-op until that PR lands.
  }, [])

  const handleOpenSourceNote = useCallback(async () => {
    if (!task?.sourceNoteId) return
    try {
      const note = await window.api.notes.get(task.sourceNoteId)
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
    } catch (err) {
      log.error('open source note failed:', extractErrorMessage(err, 'Could not open note'))
    }
  }, [task?.sourceNoteId, openTab, onDismiss])

  const handlePickDateTime = useCallback(() => {
    // Custom date-time picker dialog is a follow-up PR. For now, route to the
    // existing TaskDetailDrawer where the user can change due date/time fully.
    if (task) openForTask(task.id)
    onDismiss()
  }, [task, openForTask, onDismiss])

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
          <DialogPrimitive.Title className="sr-only">Task details</DialogPrimitive.Title>
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
            repeatSummary={summarizeRepeat(task.repeatConfig)}
            description={task.description}
            isCompleted={isCompleted}
          />
          <CalendarTaskPopoverSubtasks
            subtasks={subtasks}
            onToggleSubtask={handleToggleSubtask}
          />
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

function summarizeRepeat(cfg: RepeatConfig | null): string | null {
  if (!cfg) return null
  switch (cfg.frequency) {
    case 'daily':
      return 'Repeats daily'
    case 'weekly':
      return 'Repeats weekly'
    case 'monthly':
      return 'Repeats monthly'
    case 'yearly':
      return 'Repeats yearly'
    default:
      return 'Repeats'
  }
}
