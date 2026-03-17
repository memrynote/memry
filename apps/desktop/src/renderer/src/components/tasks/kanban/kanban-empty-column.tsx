import { Plus, Check, Calendar } from '@/lib/icons'

import { cn } from '@/lib/utils'

type EmptyVariant = 'default' | 'done' | 'schedule'

interface KanbanEmptyColumnProps {
  variant?: EmptyVariant
  isDropTarget?: boolean
}

const EMPTY_CONFIG: Record<EmptyVariant, { icon: typeof Plus; title: string; subtitle: string }> = {
  default: {
    icon: Plus,
    title: 'No tasks',
    subtitle: 'Drag tasks here or click + to add'
  },
  done: {
    icon: Check,
    title: 'No completed tasks',
    subtitle: 'Complete tasks to see them here'
  },
  schedule: {
    icon: Calendar,
    title: 'Nothing scheduled',
    subtitle: 'Drag tasks here to reschedule'
  }
}

export const KanbanEmptyColumn = ({
  variant = 'default',
  isDropTarget = false
}: KanbanEmptyColumnProps): React.JSX.Element => {
  const config = EMPTY_CONFIG[variant]
  const Icon = config.icon

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-md border border-dashed p-6 transition-colors',
        isDropTarget ? 'border-primary/40 bg-primary/[0.03]' : 'border-border/50'
      )}
    >
      <Icon className="w-5 h-5 text-text-tertiary" />
      <div className="text-center">
        <p className="text-[12px] font-medium text-muted-foreground">{config.title}</p>
        <p className="text-[11px] text-text-tertiary mt-0.5">{config.subtitle}</p>
      </div>
    </div>
  )
}
