import { TaskReminderButton } from '@/components/tasks/task-reminder-button'
import type { TaskPropertyOpenState } from './task-property-ids'

interface ReminderChipProps extends TaskPropertyOpenState {
  taskId: string
  hasActiveReminder: boolean
}

// The drawer's reminder control, reshaped to the row's chip.
const CHIP_CLASS =
  'h-5 py-0 px-1.5 gap-1 text-[11px] font-medium leading-3.5 border-border bg-transparent dark:bg-transparent hover:opacity-100 hover:bg-surface-active data-[state=open]:bg-surface-active focus-visible:ring-1 focus-visible:ring-text-tertiary'

export const ReminderChip = ({
  taskId,
  hasActiveReminder,
  open,
  onOpenChange
}: ReminderChipProps): React.JSX.Element | null => {
  const isOpen = open === 'reminder'
  if (!hasActiveReminder && !isOpen) return null

  return (
    <div className="flex shrink-0">
      <TaskReminderButton
        taskId={taskId}
        className={CHIP_CLASS}
        open={isOpen}
        onOpenChange={(next) => onOpenChange('reminder', next)}
      />
    </div>
  )
}
