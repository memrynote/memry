import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useCallback, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { useAnchoredPopoverPosition } from './popover-position'
import { CALENDAR_CARD_CLASS, isModEnter } from './calendar-card'
import { CalendarTaskPopoverHeader } from './calendar-task-popover-header'
import { CalendarTaskPopoverMeta } from './calendar-task-popover-meta'
import { CalendarTaskPopoverSubtasks } from './calendar-task-popover-subtasks'
import {
  CalendarTaskPopoverActionBar,
  CalendarTaskPopoverMenu,
  CalendarTaskPopoverMoveRow
} from './calendar-task-popover-actions'
import { useTask } from '@/hooks/use-task'
import { useSubtasks } from '@/hooks/use-subtasks'
import { useProject } from '@/hooks/use-project'
import { useNoteTagsQuery } from '@/hooks/use-notes-query'
import { useTabs } from '@/contexts/tabs'
import { useTasksOptional } from '@/contexts/tasks'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { tasksService } from '@/services/tasks-service'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import type { SnoozeTarget } from '@/lib/snooze-options'
import type { AnchorRect } from './types'
import type { RepeatConfig } from '@/services/tasks-service'

const log = createLogger('CalendarTaskPopover')

const TASK_POPOVER_WIDTH = 320

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
  const { tags: allTags } = useNoteTagsQuery({ enabled: (task?.tags?.length ?? 0) > 0 })
  const tasksContext = useTasksOptional()
  const { openTab } = useTabs()
  const { openSidebarItem } = useSidebarNavigation()
  const { t } = useT('calendar')
  const { t: tCommon } = useT('common')
  const position = useAnchoredPopoverPosition(anchorRect, {
    width: TASK_POPOVER_WIDTH,
    estimatedHeight: 340
  })
  const contentRef = useRef<HTMLDivElement | null>(null)
  const positionRef = position.ref
  const setContentRef = useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node
      positionRef(node)
    },
    [positionRef]
  )

  const isCompleted = !!task?.completedAt
  const taskProject = useMemo(
    () => tasksContext?.projects.find((p) => p.id === task?.projectId) ?? null,
    [tasksContext?.projects, task?.projectId]
  )
  const tagColorMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const tag of allTags) {
      map.set(normalizeTagName(tag.tag), tag.color || '')
    }
    return map
  }, [allTags])
  const taskTags = useMemo(
    () =>
      (task?.tags ?? []).map((tagName) => {
        const normalizedName = normalizeTagName(tagName)
        const name = tagName.replace(/^#/, '')
        return {
          id: tagName,
          name,
          color: tagColorMap.get(normalizedName) ?? ''
        }
      }),
    [task?.tags, tagColorMap]
  )

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
            extractErrorMessage(err, t('task-popover.errors.could-not-reschedule'))
          )
        })
    },
    [task, onDismiss, t]
  )

  const handleToggleComplete = useCallback((): void => {
    if (!task) return
    const taskId = task.id
    if (task.completedAt) {
      tasksService.uncomplete(taskId).catch((err: unknown) => {
        toast.error(extractErrorMessage(err, t('task-popover.errors.could-not-save')))
      })
      return
    }
    tasksService
      .complete({ id: taskId })
      .then(() => {
        onDismiss()
        toast(t('chip.task-completed'), {
          action: {
            label: tCommon('action.undo'),
            onClick: () => {
              tasksService.uncomplete(taskId).catch((err: unknown) => {
                log.error('undo complete failed:', err)
              })
            }
          }
        })
      })
      .catch((err: unknown) => {
        toast.error(extractErrorMessage(err, t('task-popover.errors.could-not-save')))
      })
  }, [task, onDismiss, t, tCommon])

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
    if (!task) return
    openTab({
      type: 'tasks',
      title: 'Tasks',
      icon: 'CheckSquare',
      path: '/tasks',
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false,
      viewState: {
        openTaskId: item.sourceId,
        selectedProjectId: task.projectId,
        activeInternalTab: 'all',
        activeTab: 'all'
      }
    })
    onDismiss()
  }, [openTab, item.sourceId, task, onDismiss])

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
          isPreview: false,
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

  const handleTagClick = useCallback(
    (tag: { name: string; color: string }): void => {
      openSidebarItem({
        type: 'tag',
        title: tag.name,
        path: '/tags/' + tag.name,
        entityId: tag.name,
        color: tag.color
      })
    },
    [openSidebarItem]
  )

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
        viewState: {
          openTaskId: task.id,
          selectedProjectId: task.projectId,
          activeInternalTab: 'all',
          activeTab: 'all'
        }
      })
    }
    onDismiss()
  }, [task, openTab, onDismiss])

  if (!task) return null

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
          tabIndex={-1}
          onOpenAutoFocus={(e) => {
            // Focus the card itself, not its first button, so ↵ and ⌘↵ reach the
            // card's own shortcuts instead of pressing whichever button got focus.
            e.preventDefault()
            contentRef.current?.focus()
          }}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return
            if (isModEnter(e)) {
              e.preventDefault()
              handleToggleComplete()
            } else if (e.key === 'Enter') {
              e.preventDefault()
              handleOpenTask()
            }
          }}
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
          ref={setContentRef}
          className={CALENDAR_CARD_CLASS}
          style={position.style}
        >
          <DialogPrimitive.Title className="sr-only">
            {t('task-popover.title-fallback')}
          </DialogPrimitive.Title>
          <CalendarTaskPopoverHeader
            task={task}
            parentTitle={parentTask?.title ?? null}
            projectName={taskProject?.name ?? project?.name ?? ''}
            onToggleComplete={handleToggleComplete}
            onOpenTask={handleOpenTask}
            menu={
              <CalendarTaskPopoverMenu
                isCompleted={isCompleted}
                sourceNoteId={task.sourceNoteId}
                onOpenSourceNote={handleOpenSourceNote}
                onPickDateTime={handlePickDateTime}
                onRemoveDueDate={handleRemoveDueDate}
              />
            }
          />
          <CalendarTaskPopoverMeta
            task={task}
            statuses={taskProject?.statuses ?? []}
            tags={taskTags}
            repeatSummary={summarizeRepeat(task.repeatConfig, t)}
            description={task.description}
            isCompleted={isCompleted}
            onTagClick={handleTagClick}
          />
          <CalendarTaskPopoverSubtasks subtasks={subtasks} onToggleSubtask={handleToggleSubtask} />
          {!isCompleted && (
            <CalendarTaskPopoverMoveRow isAllDay={!task.dueTime} onSnooze={handleSnooze} />
          )}
          <CalendarTaskPopoverActionBar
            isCompleted={isCompleted}
            onToggleComplete={handleToggleComplete}
            onOpenTask={handleOpenTask}
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

function normalizeTagName(tag: string): string {
  return tag.replace(/^#/, '').toLowerCase()
}
