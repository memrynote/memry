import { Plus } from '@/lib/icons'

import { cn } from '@/lib/utils'

type SectionDividerVariant = 'overdue' | 'default'

interface SectionDividerProps {
  label: string
  count: number
  variant?: SectionDividerVariant
  className?: string
  actions?: React.ReactNode
  onAddTask?: () => void
}

const DIVIDER_STYLES = {
  overdue: {
    label: 'text-[#C4654A]',
    divider: 'bg-[#F0DEDA] dark:bg-[#5a3030]',
    count: 'text-[#C4654A]'
  },
  default: {
    label: 'text-[#1A1A1A] dark:text-text-primary',
    divider: 'bg-[#EDECE8] dark:bg-border',
    count: 'text-[#57554F] dark:text-text-secondary'
  }
} as const

export const SectionDivider = ({
  label,
  count,
  variant = 'default',
  className,
  actions,
  onAddTask
}: SectionDividerProps): React.JSX.Element => {
  const styles = DIVIDER_STYLES[variant]

  return (
    <div className={cn('group/section flex items-center pb-2 gap-2', className)}>
      <span
        className={cn(
          'text-[12px] tracking-[0.04em] uppercase font-[family-name:var(--font-heading)] font-semibold leading-4 shrink-0',
          styles.label
        )}
      >
        {label}
      </span>
      <div className={cn('h-px grow shrink basis-0', styles.divider)} />
      {actions}
      {onAddTask && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onAddTask()
          }}
          className={cn(
            'size-5 flex items-center justify-center rounded-sm shrink-0',
            'text-text-tertiary hover:text-text-secondary hover:bg-accent/50',
            'opacity-0 group-hover/section:opacity-100 transition-all cursor-pointer',
            'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
          )}
          title={`Add task to ${label}`}
        >
          <Plus className="size-3.5" strokeWidth={2} />
        </button>
      )}
      <span
        className={cn(
          'text-[11px] font-[family-name:var(--font-mono)] font-medium leading-3.5 shrink-0',
          styles.count
        )}
      >
        {count}
      </span>
    </div>
  )
}

export type { SectionDividerVariant }
