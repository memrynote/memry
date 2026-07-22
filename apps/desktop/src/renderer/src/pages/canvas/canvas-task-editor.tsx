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
import type { Priority, Task as UiTask } from '@/data/task-model'

const DESCRIPTION_SAVE_DEBOUNCE_MS = 500

interface CanvasTaskEditorProps {
  taskId: string
}

export const CanvasTaskEditor = ({ taskId }: CanvasTaskEditorProps): React.JSX.Element => {
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

  useEffect(() => flushDescription, [flushDescription])

  const handleDescriptionChange = useCallback(
    (markdown: string) => {
      pendingDescriptionRef.current = markdown
      if (descriptionTimerRef.current) clearTimeout(descriptionTimerRef.current)
      descriptionTimerRef.current = setTimeout(flushDescription, DESCRIPTION_SAVE_DEBOUNCE_MS)
    },
    [flushDescription]
  )

  if (!task) {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-3 text-[13px] text-text-tertiary">
        {tCommon('state.loading')}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
      <input
        type="text"
        data-canvas-task-title
        value={task.title}
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
        onContentChange={handleDescriptionChange}
        placeholder={t('task.descriptionPlaceholder')}
        className="text-[13px] leading-5 text-text-secondary"
      />
    </div>
  )
}
