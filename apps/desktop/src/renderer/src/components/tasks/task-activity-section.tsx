import { useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { useTaskActivity, ACTIVITY_PREVIEW_SIZE } from '@/hooks/use-task-activity'
import { TaskActivityRow } from './task-activity-row'
import { TaskActivitySheet } from './task-activity-sheet'
import { DrawerSection, DrawerSectionHeading } from './drawer-section'

export interface TaskActivitySectionProps {
  taskId: string
  taskTitle: string
  language: string
  /** The section's heading text; rendered with the drawer's shared heading. */
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
    <DrawerSection className="pb-3">
      <DrawerSectionHeading
        trailing={
          total > entries.length && (
            <button
              type="button"
              onClick={() => setIsSheetOpen(true)}
              className="text-[12px] leading-4 text-text-tertiary hover:text-text-secondary transition-colors"
            >
              {t('drawer.activityShowAll', { count: total })}
            </button>
          )
        }
      >
        {label}
      </DrawerSectionHeading>

      {/* `px-2` puts the timeline gutter on the drawer's icon lane. */}
      <div className="flex flex-col px-2 pt-1">
        {isLoading && (
          <span className="text-[12px] leading-4 text-text-tertiary">
            {t('drawer.activityLoading')}
          </span>
        )}
        {error && (
          <span className="text-[12px] leading-4 text-destructive">
            {t('drawer.activityError')}
          </span>
        )}
        {!isLoading && !error && entries.length === 0 && (
          <span className="text-[12px] leading-4 text-text-tertiary">
            {t('drawer.activityEmpty')}
          </span>
        )}

        {entries.map((entry) => (
          <TaskActivityRow key={entry.id} entry={entry} language={language} />
        ))}
      </div>

      <TaskActivitySheet
        open={isSheetOpen}
        onOpenChange={setIsSheetOpen}
        taskId={taskId}
        taskTitle={taskTitle}
        language={language}
      />
    </DrawerSection>
  )
}
