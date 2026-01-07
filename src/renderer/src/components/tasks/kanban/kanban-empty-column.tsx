import { cn } from '@/lib/utils'

// ============================================================================
// TYPES
// ============================================================================

interface KanbanEmptyColumnProps {
  columnType: 'status' | 'project'
  isDone?: boolean
  isDropTarget?: boolean
  className?: string
}

// ============================================================================
// KANBAN EMPTY COLUMN COMPONENT
// ============================================================================

export const KanbanEmptyColumn = ({
  columnType,
  isDone = false,
  isDropTarget = false,
  className
}: KanbanEmptyColumnProps): React.JSX.Element => {
  // Message based on column type and state
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

    return {
      title: 'No tasks',
      description: 'Drag tasks here or click add'
    }
  }

  const { title, description } = getMessage()

  return (
    <div
      className={cn(
        'flex flex-1 flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center transition-colors',
        isDropTarget ? 'border-primary bg-primary/5' : 'border-border/50 bg-muted/20',
        className
      )}
    >
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground/70">{description}</p>
    </div>
  )
}

export default KanbanEmptyColumn
