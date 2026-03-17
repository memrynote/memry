import { ClipboardList, Star, CheckCircle, FolderOpen, Plus } from '@/lib/icons'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// ============================================================================
// TYPES
// ============================================================================

type EmptyStateVariant = 'all' | 'today' | 'completed' | 'project'

interface TaskEmptyStateProps {
  variant: EmptyStateVariant
  projectName?: string
  onAddTask?: () => void
  className?: string
}

// ============================================================================
// EMPTY STATE CONFIGURATIONS
// ============================================================================

interface EmptyStateConfig {
  icon: React.ElementType
  title: string
  description: string
  showAddButton: boolean
}

const emptyStateConfigs: Record<EmptyStateVariant, EmptyStateConfig> = {
  all: {
    icon: ClipboardList,
    title: 'No tasks yet',
    description: 'Create your first task to get started',
    showAddButton: true
  },
  today: {
    icon: Star,
    title: 'Nothing due today',
    description: "You're all caught up!",
    showAddButton: false
  },
  completed: {
    icon: CheckCircle,
    title: 'No completed tasks',
    description: 'Completed tasks will appear here',
    showAddButton: false
  },
  project: {
    icon: FolderOpen,
    title: 'No tasks in this project',
    description: 'Add a task to get started',
    showAddButton: true
  }
}

// ============================================================================
// TASK EMPTY STATE COMPONENT
// ============================================================================

export const TaskEmptyState = ({
  variant,
  projectName,
  onAddTask,
  className
}: TaskEmptyStateProps): React.JSX.Element => {
  const config = emptyStateConfigs[variant]
  const Icon = config.icon

  // Customize title for project variant
  const title = variant === 'project' && projectName ? `No tasks in ${projectName}` : config.title

  return (
    <div className={cn('flex flex-col items-center justify-center py-16 text-center', className)}>
      {/* Icon */}
      <div className="mb-4 rounded-full bg-muted p-4">
        <Icon className="size-8 text-text-tertiary" aria-hidden="true" />
      </div>

      {/* Title */}
      <h3 className="mb-2 text-lg font-medium text-text-primary">{title}</h3>

      {/* Description */}
      <p className="mb-6 max-w-sm text-sm text-text-tertiary">{config.description}</p>

      {/* Add Task Button */}
      {config.showAddButton && onAddTask && (
        <Button onClick={onAddTask} size="sm">
          <Plus className="size-4" aria-hidden="true" />
          Add Task
        </Button>
      )}
    </div>
  )
}

export default TaskEmptyState
