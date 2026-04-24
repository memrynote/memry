import { cn } from '@/lib/utils'
import { priorityConfig, type Priority } from '@/data/sample-tasks'

interface PriorityBarsProps {
  priority: Priority
  className?: string
}

export const PriorityBars = ({ priority, className }: PriorityBarsProps): React.JSX.Element => {
  if (priority === 'none') {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        className={cn('shrink-0', className)}
        aria-label="no priority"
      >
        <line
          x1="2"
          y1="7"
          x2="12"
          y2="7"
          stroke="var(--text-tertiary)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    )
  }

  const color = priorityConfig[priority].color!

  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      className={cn('shrink-0', className)}
      aria-label={`${priority} priority`}
    >
      {priority === 'urgent' ? (
        <>
          <rect x="1.5" y="8" width="2.5" height="4.5" rx="0.5" fill={color} />
          <rect x="5.5" y="5" width="2.5" height="7.5" rx="0.5" fill={color} />
          <rect x="9.5" y="2" width="2.5" height="10.5" rx="0.5" fill={color} />
        </>
      ) : priority === 'high' ? (
        <>
          <rect x="1.5" y="6" width="2.5" height="6.5" rx="0.5" fill={color} />
          <rect x="5.5" y="3.5" width="2.5" height="9" rx="0.5" fill={color} />
          <rect
            x="9.5"
            y="1"
            width="2.5"
            height="11.5"
            rx="0.5"
            fill="var(--text-tertiary)"
            opacity={0.4}
          />
        </>
      ) : priority === 'medium' ? (
        <>
          <rect x="1.5" y="6" width="2.5" height="6.5" rx="0.5" fill="var(--text-primary)" />
          <rect
            x="5.5"
            y="3.5"
            width="2.5"
            height="9"
            rx="0.5"
            fill="var(--text-tertiary)"
            opacity={0.4}
          />
          <rect
            x="9.5"
            y="1"
            width="2.5"
            height="11.5"
            rx="0.5"
            fill="var(--text-tertiary)"
            opacity={0.4}
          />
        </>
      ) : (
        <>
          <rect
            x="1.5"
            y="6"
            width="2.5"
            height="6.5"
            rx="0.5"
            fill="var(--text-tertiary)"
            opacity={0.6}
          />
          <rect
            x="5.5"
            y="3.5"
            width="2.5"
            height="9"
            rx="0.5"
            fill="var(--text-tertiary)"
            opacity={0.25}
          />
          <rect
            x="9.5"
            y="1"
            width="2.5"
            height="11.5"
            rx="0.5"
            fill="var(--text-tertiary)"
            opacity={0.25}
          />
        </>
      )}
    </svg>
  )
}

// ============================================================================
// PRIORITY STAR — Used in group headers for urgent priority
// ============================================================================

export const PriorityStar = ({
  color,
  className
}: {
  color: string
  className?: string
}): React.JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className={cn('shrink-0', className)}>
    <path
      d="M7 2l1.5 3.5H13L9.5 8l1 3.5L7 9l-3.5 2.5 1-3.5L1 5.5h4.5z"
      fill={color}
      stroke={color}
      strokeWidth="0.5"
    />
  </svg>
)

// ============================================================================
// PRIORITY ICON — Pure display icon for priority level (13×13)
// Used in filter panels, interactive badges, and task detail drawer
// ============================================================================

const PI = {
  destructive: 'var(--destructive)',
  orange: 'var(--accent-orange)',
  fg: 'var(--foreground)',
  tertiary: 'var(--text-tertiary)',
  border: 'var(--border)'
} as const

const PRIORITY_ICON_MAP: Record<Priority, React.ReactNode> = {
  urgent: (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <rect x="1" y="7" width="2.2" height="4" rx="0.5" style={{ fill: PI.destructive }} />
      <rect x="5" y="4.5" width="2.2" height="6.5" rx="0.5" style={{ fill: PI.destructive }} />
      <rect x="9" y="2" width="2.2" height="9" rx="0.5" style={{ fill: PI.destructive }} />
    </svg>
  ),
  high: (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <rect x="1" y="5.5" width="2.2" height="5.5" rx="0.5" style={{ fill: PI.orange }} />
      <rect x="5" y="3" width="2.2" height="8" rx="0.5" style={{ fill: PI.orange }} />
      <rect x="9" y="1" width="2.2" height="10" rx="0.5" style={{ fill: PI.border }} />
    </svg>
  ),
  medium: (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <rect x="1" y="5.5" width="2.2" height="5.5" rx="0.5" style={{ fill: PI.fg }} />
      <rect x="5" y="3" width="2.2" height="8" rx="0.5" style={{ fill: PI.border }} />
      <rect x="9" y="1" width="2.2" height="10" rx="0.5" style={{ fill: PI.border }} />
    </svg>
  ),
  low: (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <rect
        x="1"
        y="5.5"
        width="2.2"
        height="5.5"
        rx="0.5"
        style={{ fill: PI.tertiary, opacity: 0.6 }}
      />
      <rect x="5" y="3" width="2.2" height="8" rx="0.5" style={{ fill: PI.border }} />
      <rect x="9" y="1" width="2.2" height="10" rx="0.5" style={{ fill: PI.border }} />
    </svg>
  ),
  none: (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M3 6.5h7" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

interface PriorityIconProps {
  priority: Priority
  className?: string
}

export const PriorityIcon = ({ priority, className }: PriorityIconProps): React.JSX.Element => (
  <span className={cn('shrink-0 flex items-center', className)}>{PRIORITY_ICON_MAP[priority]}</span>
)
