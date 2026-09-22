import { Calendar, ChevronDown, Clock, FileText, FolderOpen } from '@/lib/icons'

import { cn } from '@/lib/utils'
import { PriorityBars, PriorityStar } from '@/components/tasks/task-icons'
import { priorityConfig, type Priority } from '@/data/task-model'
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

interface IconProps {
  className?: string
  style?: React.CSSProperties
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

/**
 * The marker between the chevron and the label. Every grouping mode brings its
 * own, and priority and project each need a second decision on top, so the
 * choice lives here instead of as six conditional children of the header.
 */
const SIMPLE_GROUP_ICONS: Partial<
  Record<SortField, { Icon: React.ComponentType<IconProps>; tinted: boolean }>
> = {
  dueDate: { Icon: Calendar, tinted: true },
  createdAt: { Icon: Clock, tinted: true },
  folder: { Icon: FolderOpen, tinted: false },
  note: { Icon: FileText, tinted: false }
}

const GroupLeadingIcon = ({
  sortField,
  groupKey,
  color,
  labelColor
}: {
  sortField: SortField
  groupKey: string
  color?: string
  labelColor?: string
}): React.JSX.Element | null => {
  if (sortField === 'priority') {
    return groupKey === 'urgent' && color ? (
      <PriorityStar color={color} />
    ) : (
      <PriorityBars priority={groupKey as Priority} />
    )
  }

  if (sortField === 'project') {
    return color ? (
      <div className="rounded-xs shrink-0 size-2" style={{ backgroundColor: color }} />
    ) : null
  }

  const entry = SIMPLE_GROUP_ICONS[sortField]
  if (!entry) return null

  const { Icon, tinted } = entry
  return (
    <Icon
      className={cn('size-3.5 shrink-0', !tinted && 'text-text-tertiary')}
      style={tinted && labelColor ? { color: labelColor } : undefined}
    />
  )
}

const getGroupLabelColor = (
  sortField: SortField,
  groupKey: string,
  color?: string
): string | undefined => {
  if (sortField === 'priority') return priorityConfig[groupKey as Priority]?.color ?? undefined
  if (color && (sortField === 'dueDate' || sortField === 'createdAt')) return color
  if (DONE_GROUP_KEYS.has(groupKey)) return 'var(--task-complete)'
  return undefined
}

/** Done groups never light up, and priority groups hover at their own tint. */
const getGroupHoverBgColor = (
  sortField: SortField,
  groupKey: string,
  bgColor?: string
): string | undefined => {
  if (DONE_GROUP_KEYS.has(groupKey)) return undefined
  if (sortField === 'priority') return bgColor
  return bgColor ? bgColor.replace('0.10)', '0.16)') : undefined
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
  const labelColor = getGroupLabelColor(sortField, groupKey, color)
  const bgColor = getGroupBgColor(sortField, groupKey, color)
  const isPriorityGroup = sortField === 'priority'
  const hoverBgColor = getGroupHoverBgColor(sortField, groupKey, bgColor)

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

      <GroupLeadingIcon
        sortField={sortField}
        groupKey={groupKey}
        color={color}
        labelColor={labelColor}
      />

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
