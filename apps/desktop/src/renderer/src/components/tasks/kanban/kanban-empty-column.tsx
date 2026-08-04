import { Plus, Check, Calendar } from '@/lib/icons'

import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

type EmptyVariant = 'default' | 'done' | 'schedule'

interface KanbanEmptyColumnProps {
  variant?: EmptyVariant
  isDropTarget?: boolean
}

const EMPTY_CONFIG: Record<
  EmptyVariant,
  { icon: typeof Plus; titleKey: string; subtitleKey: string }
> = {
  default: {
    icon: Plus,
    titleKey: 'kanban.empty.default.title',
    subtitleKey: 'kanban.empty.default.subtitle'
  },
  done: {
    icon: Check,
    titleKey: 'kanban.empty.done.title',
    subtitleKey: 'kanban.empty.done.subtitle'
  },
  schedule: {
    icon: Calendar,
    titleKey: 'kanban.empty.schedule.title',
    subtitleKey: 'kanban.empty.schedule.subtitle'
  }
}

export const KanbanEmptyColumn = ({
  variant = 'default',
  isDropTarget = false
}: KanbanEmptyColumnProps): React.JSX.Element => {
  const { t } = useT('tasks')
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
        <p className="text-[12px] font-medium text-muted-foreground">{t(config.titleKey)}</p>
        <p className="text-[11px] text-text-tertiary mt-0.5">{t(config.subtitleKey)}</p>
      </div>
    </div>
  )
}
