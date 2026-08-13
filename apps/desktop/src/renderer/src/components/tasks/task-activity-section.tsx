import { useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { useTaskActivity, ACTIVITY_PREVIEW_SIZE } from '@/hooks/use-task-activity'
import { TaskActivityRow } from './task-activity-row'
import { TaskActivitySheet } from './task-activity-sheet'

export interface TaskActivitySectionProps {
  taskId: string
  taskTitle: string
  language: string
  /** The drawer's own SectionLabel, passed in so this matches its siblings. */
  label: React.ReactNode
}

/**
 * The drawer's inline activity preview.
 *
 * Three rows and a way in. Keeping it inline is what makes the audit trail
 * discoverable — someone asking "why is this due date different?" opens the
 * task, not a separate panel — while the full, filterable feed lives in a Sheet
 * that has room for it.
 */
export function TaskActivitySection({
  taskId,
  taskTitle,
  language,
  label
}: TaskActivitySectionProps): React.JSX.Element {
  const { t } = useT('tasks')
  const [isSheetOpen, setIsSheetOpen] = useState(false)

  const { entries, total, isLoading, error } = useTaskActivity({
    taskId,
    limit: ACTIVITY_PREVIEW_SIZE
  })

  return (
    <div className="flex flex-col py-4 px-5 gap-2 border-b border-border">
      <div className="flex items-center justify-between">
        {label}
        {total > entries.length && (
          <button
            type="button"
            onClick={() => setIsSheetOpen(true)}
            className="text-[11px] leading-3.5 text-text-tertiary hover:text-text-secondary transition-colors"
          >
            {t('drawer.activityShowAll', { count: total })}
          </button>
        )}
      </div>

      {isLoading && (
        <span className="text-[11px] leading-3.5 text-text-tertiary">
          {t('drawer.activityLoading')}
        </span>
      )}
      {error && (
        <span className="text-[11px] leading-3.5 text-destructive">
          {t('drawer.activityError')}
        </span>
      )}
      {!isLoading && !error && entries.length === 0 && (
        <span className="text-[11px] leading-3.5 text-text-tertiary">
          {t('drawer.activityEmpty')}
        </span>
      )}

      {entries.map((entry) => (
        <TaskActivityRow key={entry.id} entry={entry} language={language} />
      ))}

      <TaskActivitySheet
        open={isSheetOpen}
        onOpenChange={setIsSheetOpen}
        taskId={taskId}
        taskTitle={taskTitle}
        language={language}
      />
    </div>
  )
}
