/**
 * CanvasTaskEditor — slim in-place task editor for an active task card on the
 * spatial canvas (M6 Task 6, matrix #22 task). Reuses the standalone field
 * components the task detail drawer composes (title input, status/priority/
 * due-date badges, description editor) rather than the full drawer body
 * (decision D2). Writes route through the shared
 * `useTaskWorkspaceMutations().updateTask` mapper — never a reimplemented
 * `tasksService.update` call — so priority-enum / date-string mapping and the
 * completed/archived special-casing stay in one place. No submit button:
 * every field autosaves on change, sidestepping the disable-mid-click trap.
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { useT } from '@memry/i18n/renderer'
import { useTaskWorkspaceData, useTaskWorkspaceMutations } from '@/features/tasks/use-task-queries'
import { InteractiveStatusBadge } from '@/components/tasks/interactive-status-badge'
import { InteractivePriorityBadge } from '@/components/tasks/interactive-priority-badge'
import { InteractiveDueDateBadge } from '@/components/tasks/interactive-due-date-badge'
import { TaskDescriptionEditor } from '@/components/tasks/task-description-editor'
import { registerPendingSave, unregisterPendingSave } from '@/lib/save-registry'
import { cn } from '@/lib/utils'
import type { Priority, Task as UiTask } from '@/data/task-model'

const DESCRIPTION_SAVE_DEBOUNCE_MS = 500

interface CanvasTaskEditorProps {
  taskId: string
  /**
   * False on an idle card: identical tree, read-only leaves, natural height
   * (the card shell owns scrolling then — see canvas-card-scroll.ts).
   */
  interactive?: boolean
}

export const CanvasTaskEditor = ({
  taskId,
  interactive = true
}: CanvasTaskEditorProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const { t: tCommon } = useT('common')
  const { tasks, projects } = useTaskWorkspaceData({ enabled: true })
  const { updateTask } = useTaskWorkspaceMutations()

  const task = useMemo<UiTask | null>(
    () => tasks.find((t) => t.id === taskId) ?? null,
    [tasks, taskId]
  )
  const project = useMemo(
    () => (task ? (projects.find((p) => p.id === task.projectId) ?? null) : null),
    [task, projects]
  )

  // Description is a BlockNote markdown editor; debounce persistence so we
  // don't write to the DB (and bump the sync field clock) on every keystroke —
  // mirrors task-detail-drawer.tsx's handleDescriptionChange/flushDescription.
  const pendingDescriptionRef = useRef<string | null>(null)
  const descriptionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushDescription = useCallback(() => {
    if (descriptionTimerRef.current) {
      clearTimeout(descriptionTimerRef.current)
      descriptionTimerRef.current = null
    }
    if (pendingDescriptionRef.current !== null && task) {
      void updateTask(task.id, { description: pendingDescriptionRef.current })
      pendingDescriptionRef.current = null
    }
  }, [task, updateTask])

  // Register the debounced flush with the save-registry so an app quit /
  // app:request-flush handshake during the debounce window doesn't drop the
  // last <500ms of a description edit — mirrors embedded-note-editor.tsx.
  useEffect(() => {
    if (!interactive) return
    const registryKey = `canvas-task:${taskId}`
    registerPendingSave(registryKey, flushDescription)
    return () => {
      unregisterPendingSave(registryKey)
      flushDescription()
    }
  }, [taskId, flushDescription, interactive])

  const handleDescriptionChange = useCallback(
    (markdown: string) => {
      pendingDescriptionRef.current = markdown
      if (descriptionTimerRef.current) clearTimeout(descriptionTimerRef.current)
      descriptionTimerRef.current = setTimeout(flushDescription, DESCRIPTION_SAVE_DEBOUNCE_MS)
    },
    [flushDescription]
  )

  // An idle card lets its content run at natural height and the card shell
  // clips + scrolls it; an active card scrolls itself.
  const rootLayout = interactive ? 'min-h-0 flex-1 overflow-auto' : 'w-full'

  if (!task) {
    return (
      <div className={cn('p-3 text-[13px] text-text-tertiary', rootLayout)}>
        {tCommon('state.loading')}
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col gap-2 p-3', rootLayout)}>
      <input
        type="text"
        data-canvas-task-title
        value={task.title}
        readOnly={!interactive}
        onChange={(e) => void updateTask(task.id, { title: e.target.value })}
        placeholder={t('task.namePlaceholder')}
        aria-label={t('task.namePlaceholder')}
        className="w-full min-w-0 bg-transparent text-[13px] font-medium text-text-primary outline-none"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <InteractiveStatusBadge
          statusId={task.statusId}
          statuses={project?.statuses ?? []}
          onStatusChange={(statusId) => void updateTask(task.id, { statusId })}
        />
        <InteractivePriorityBadge
          priority={task.priority}
          onPriorityChange={(priority: Priority) => void updateTask(task.id, { priority })}
          compact
        />
        <InteractiveDueDateBadge
          dueDate={task.dueDate}
          dueTime={task.dueTime}
          onDateChange={(dueDate) => void updateTask(task.id, { dueDate })}
          onTimeChange={(dueTime) => void updateTask(task.id, { dueTime })}
          isRepeating={task.isRepeating}
        />
      </div>
      <TaskDescriptionEditor
        key={task.id}
        initialContent={task.description}
        editable={interactive}
        onContentChange={interactive ? handleDescriptionChange : undefined}
        placeholder={t('task.descriptionPlaceholder')}
        className="text-[13px] leading-5 text-text-secondary"
      />
    </div>
  )
}
