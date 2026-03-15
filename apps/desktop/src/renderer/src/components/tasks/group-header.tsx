import { Calendar, Clock } from 'lucide-react'

import { cn } from '@/lib/utils'
import { PriorityBars, PriorityStar } from '@/components/tasks/task-icons'
import type { Priority } from '@/data/sample-tasks'
import type { SortField } from '@/data/tasks-data'

// ============================================================================
// GROUP HEADER — Linear-style collapsible section divider
// ============================================================================

interface GroupHeaderProps {
  label: string
  count: number
  sortField: SortField
  groupKey: string
  color?: string
  variant?: 'overdue' | 'default'
  isCollapsed?: boolean
  onToggle?: () => void
}

export const GroupHeader = ({
  label,
  count,
  sortField,
  groupKey,
  color,
  variant = 'default',
  isCollapsed = false,
  onToggle
}: GroupHeaderProps): React.JSX.Element => {
  const isOverdue = variant === 'overdue'

  const labelColor = (() => {
    if (sortField === 'priority' && color) return color
    if (isOverdue) return 'var(--destructive)'
    return undefined
  })()

  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'flex items-center w-full py-2 px-6 gap-2 bg-foreground/[0.02] border-b border-border',
        'cursor-pointer select-none transition-colors hover:bg-foreground/[0.04]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
      aria-expanded={!isCollapsed}
      aria-label={`${label}, ${count} tasks${isCollapsed ? ', collapsed' : ''}`}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="none"
        className={cn(
          'shrink-0 text-text-tertiary transition-transform duration-150',
          isCollapsed ? '-rotate-90' : ''
        )}
      >
        <path
          d="M2.5 3.5L5 6.5L7.5 3.5"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>

      {sortField === 'priority' &&
        (groupKey === 'urgent' && color ? (
          <PriorityStar color={color} />
        ) : (
          <PriorityBars priority={groupKey as Priority} />
        ))}

      {sortField === 'dueDate' && (
        <Calendar
          className={cn('size-3.5 shrink-0', isOverdue ? 'text-destructive' : 'text-text-tertiary')}
        />
      )}

      {sortField === 'project' && color && (
        <div className="rounded-xs shrink-0 size-2" style={{ backgroundColor: color }} />
      )}

      {sortField === 'createdAt' && <Clock className="size-3.5 shrink-0 text-text-tertiary" />}

      <div
        className={cn(
          'text-[12px] tracking-[0.02em] font-semibold leading-4',
          !labelColor && 'text-text-secondary'
        )}
        style={labelColor ? { color: labelColor } : undefined}
      >
        {label}
      </div>

      <div className="text-[11px] text-text-tertiary leading-3.5">{count}</div>
    </button>
  )
}
