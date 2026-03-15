import { cn } from '@/lib/utils'
import { getDayHeaderText } from '@/lib/task-utils'
import { SectionDivider } from '@/components/tasks/section-divider'

interface DaySectionHeaderProps {
  date: Date
  taskCount: number
  className?: string
  onAddTask?: () => void
}

export const DaySectionHeader = ({
  date,
  taskCount,
  className,
  onAddTask
}: DaySectionHeaderProps): React.JSX.Element => {
  const { primary, secondary } = getDayHeaderText(date)

  return (
    <SectionDivider
      label={`${primary} · ${secondary}`}
      count={taskCount}
      className={cn('pt-1', className)}
      onAddTask={onAddTask}
    />
  )
}

export default DaySectionHeader
