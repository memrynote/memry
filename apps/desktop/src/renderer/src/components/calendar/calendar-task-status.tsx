import { useCallback } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { InlineStatusPopover } from '@/components/tasks/inline-status-popover'
import { StatusIcon } from '@/components/tasks/status-icon'
import { useTasksOptional } from '@/contexts/tasks'
import { tasksService } from '@/services/tasks-service'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'

const log = createLogger('CalendarTaskStatus')

interface CalendarTaskStatusProps {
  taskId: string
  projectId: string
  statusId: string | null
  isCompleted: boolean
  size?: 'sm' | 'md' | 'lg'
}

/**
 * A calendar task's status: its project's own icon, and a dropdown of that
 * project's statuses. Picking a `done` status completes the task; picking any
 * other reopens it. The task stays on the calendar either way, drawn faded.
 */
export function CalendarTaskStatus({
  taskId,
  projectId,
  statusId,
  isCompleted,
  size = 'md'
}: CalendarTaskStatusProps): React.JSX.Element | null {
  const { t } = useT('calendar')
  const { t: tCommon } = useT('common')
  const statuses = useTasksOptional()?.projects.find((p) => p.id === projectId)?.statuses

  const handleStatusChange = useCallback(
    (nextStatusId: string): void => {
      const nextType = statuses?.find((s) => s.id === nextStatusId)?.type
      const run = async (): Promise<void> => {
        await tasksService.update({ id: taskId, statusId: nextStatusId })
        if (nextType === 'done' && !isCompleted) {
          await tasksService.complete({ id: taskId })
          toast(t('chip.task-completed'), {
            action: {
              label: tCommon('action.undo'),
              onClick: () => {
                tasksService.uncomplete(taskId).catch((err: unknown) => {
                  log.error('undo complete failed', err)
                })
              }
            }
          })
        } else if (nextType !== 'done' && isCompleted) {
          await tasksService.uncomplete(taskId)
        }
      }
      run().catch((err: unknown) => {
        toast.error(extractErrorMessage(err, t('chip.could-not-update-status')))
      })
    },
    [statuses, taskId, isCompleted, t, tCommon]
  )

  if (!statuses || statuses.length === 0) {
    return (
      <StatusIcon type={isCompleted ? 'done' : 'todo'} color="var(--text-tertiary)" size={size} />
    )
  }

  return (
    <InlineStatusPopover
      statusId={statusId ?? ''}
      statuses={statuses}
      isCompleted={isCompleted}
      size={size}
      onStatusChange={handleStatusChange}
      // The status change above completes or reopens; the popover's own
      // follow-up toggle would race it.
      onToggleComplete={() => {}}
    />
  )
}
