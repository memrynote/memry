import { cn } from '@/lib/utils'

// ============================================================================
// TYPES
// ============================================================================

interface KanbanEmptyColumnProps {
  columnType: 'status' | 'project' | 'weekday'
  isDone?: boolean
  isDropTarget?: boolean
  className?: string
}

// ============================================================================
// KANBAN EMPTY COLUMN
// ============================================================================

export const KanbanEmptyColumn = ({
  columnType,
  isDone = false,
  isDropTarget = false,
  className
}: KanbanEmptyColumnProps): React.JSX.Element => {
  const getMessage = (): { title: string; description: string } => {
    if (isDone) {
      return {
        title: 'No completed tasks',
        description: 'Complete tasks to see them here'
      }
    }
    if (columnType === 'project') {
      return {
        title: 'No tasks in this project',
        description: 'Drag tasks here or click add'
      }
    }
    if (columnType === 'weekday') {
      return {
        title: 'Nothing scheduled',
        description: 'Drag tasks here to reschedule'
      }
    }
    return {
      title: 'No tasks',
      description: 'Drag tasks here or click add'
    }
  }

  const { title, description } = getMessage()

  return (
    <div
      className={cn(
        'flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed p-6 text-center transition-colors',
        isDropTarget ? 'border-primary/40 bg-primary/[0.03]' : 'border-border/50',
        className
      )}
    >
      <p className="text-[13px] font-medium text-muted-foreground">{title}</p>
      <p className="mt-1 text-[11px] text-text-tertiary">{description}</p>
    </div>
  )
}

export default KanbanEmptyColumn
