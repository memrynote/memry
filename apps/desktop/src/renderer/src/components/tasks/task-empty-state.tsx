import { ClipboardList, Star, CheckCircle, FolderOpen, Plus } from '@/lib/icons'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

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
  titleKey: string
  descriptionKey: string
  showAddButton: boolean
}

const emptyStateConfigs: Record<EmptyStateVariant, EmptyStateConfig> = {
  all: {
    icon: ClipboardList,
    titleKey: 'phaseF.componentsTasksTaskEmptyState.allTitle',
    descriptionKey: 'phaseF.componentsTasksTaskEmptyState.allDescription',
    showAddButton: true
  },
  today: {
    icon: Star,
    titleKey: 'phaseF.componentsTasksTaskEmptyState.todayTitle',
    descriptionKey: 'phaseF.componentsTasksTaskEmptyState.todayDescription',
    showAddButton: false
  },
  completed: {
    icon: CheckCircle,
    titleKey: 'phaseF.componentsTasksTaskEmptyState.completedTitle',
    descriptionKey: 'phaseF.componentsTasksTaskEmptyState.completedDescription',
    showAddButton: false
  },
  project: {
    icon: FolderOpen,
    titleKey: 'phaseF.componentsTasksTaskEmptyState.projectTitle',
    descriptionKey: 'phaseF.componentsTasksTaskEmptyState.projectDescription',
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
  const { t: tPhaseF } = useT('tasks')
  const config = emptyStateConfigs[variant]
  const Icon = config.icon

  // Customize title for project variant
  const title =
    variant === 'project' && projectName
      ? tPhaseF('phaseF.componentsTasksTaskEmptyState.projectTitleNamed', { name: projectName })
      : tPhaseF(config.titleKey)

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center py-16 text-center fade-in-up',
        className
      )}
    >
      {/* Icon */}
      <div className="mb-4 rounded-full bg-muted p-4">
        <Icon className="size-8 text-text-tertiary" aria-hidden="true" />
      </div>

      {/* Title */}
      <h3 className="mb-2 text-lg font-medium text-text-primary">{title}</h3>

      {/* Description */}
      <p className="mb-6 max-w-sm text-sm text-text-tertiary">{tPhaseF(config.descriptionKey)}</p>

      {/* Add Task Button */}
      {config.showAddButton && onAddTask && (
        <Button onClick={onAddTask} size="sm">
          <Plus className="size-4" aria-hidden="true" />

          {tPhaseF('phaseF.componentsTasksTaskEmptyState.addTask')}
        </Button>
      )}
    </div>
  )
}

export default TaskEmptyState
