import { Calendar, ChevronDown, Clock } from '@/lib/icons'

import { cn } from '@/lib/utils'
import { PriorityBars, PriorityStar } from '@/components/tasks/task-icons'
import { priorityConfig, type Priority } from '@/data/sample-tasks'
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

const DONE_GROUP_KEYS = new Set(['done', 'completed'])

const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
  const clean = hex.replace('#', '')
  if (clean.length !== 6) return null
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16)
  }
}

const getGroupBgColor = (
  sortField: SortField,
  groupKey: string,
  color?: string
): string | undefined => {
  if (DONE_GROUP_KEYS.has(groupKey)) return undefined

  if (!color) return undefined

  const rgb = hexToRgb(color)
  if (!rgb) return undefined

  if (sortField === 'project' || sortField === 'createdAt') {
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.10)`
  }

  return undefined
}

export const GroupHeader = ({
  label,
  count,
  sortField,
  groupKey,
  color,
  isCollapsed = false,
  onToggle
}: GroupHeaderProps): React.JSX.Element => {
  const labelColor = (() => {
    if (sortField === 'priority') return priorityConfig[groupKey as Priority]?.color ?? undefined
    if (color && (sortField === 'dueDate' || sortField === 'createdAt')) return color
    if (DONE_GROUP_KEYS.has(groupKey)) return 'var(--task-complete)'
    return undefined
  })()

  const bgColor = getGroupBgColor(sortField, groupKey, color)
  const isDoneGroup = DONE_GROUP_KEYS.has(groupKey)
  const isPriorityGroup = sortField === 'priority'
  const hoverBgColor = isDoneGroup
    ? undefined
    : isPriorityGroup
      ? bgColor
      : bgColor
        ? bgColor.replace('0.10)', '0.16)')
        : undefined

  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'flex items-center w-full py-2 px-6 gap-2',
        'cursor-pointer select-none transition-colors',
        'focus-visible:outline-none',
        !bgColor && 'bg-foreground/[0.02] hover:bg-foreground/[0.04]'
      )}
      style={
        bgColor
          ? ({ backgroundColor: bgColor, '--hover-bg': hoverBgColor } as React.CSSProperties)
          : undefined
      }
      onMouseEnter={(e) => {
        if (hoverBgColor) e.currentTarget.style.backgroundColor = hoverBgColor
      }}
      onMouseLeave={(e) => {
        if (bgColor) e.currentTarget.style.backgroundColor = bgColor
      }}
      aria-expanded={!isCollapsed}
      aria-label={`${label}, ${count} tasks${isCollapsed ? ', collapsed' : ''}`}
    >
      <ChevronDown
        size={10}
        className={cn(
          'shrink-0 transition-transform duration-150',
          labelColor ? '' : 'text-text-tertiary',
          isCollapsed ? '-rotate-90' : ''
        )}
        style={labelColor ? { color: labelColor } : undefined}
      />

      {sortField === 'priority' &&
        (groupKey === 'urgent' && color ? (
          <PriorityStar color={color} />
        ) : (
          <PriorityBars priority={groupKey as Priority} />
        ))}

      {sortField === 'dueDate' && (
        <Calendar
          className="size-3.5 shrink-0"
          style={labelColor ? { color: labelColor } : undefined}
        />
      )}

      {sortField === 'project' && color && (
        <div className="rounded-xs shrink-0 size-2" style={{ backgroundColor: color }} />
      )}

      {sortField === 'createdAt' && (
        <Clock
          className="size-3.5 shrink-0"
          style={labelColor ? { color: labelColor } : undefined}
        />
      )}

      <div
        className={cn(
          'text-[12px] tracking-[0.02em] font-semibold leading-4',
          !labelColor && 'text-text-secondary'
        )}
        style={labelColor ? { color: labelColor } : undefined}
      >
        {label}
      </div>

      <div
        className="text-[12px] font-medium text-text-tertiary tabular-nums leading-4"
        style={labelColor && !isPriorityGroup ? { color: labelColor, opacity: 0.7 } : undefined}
      >
        {count}
      </div>
    </button>
  )
}
