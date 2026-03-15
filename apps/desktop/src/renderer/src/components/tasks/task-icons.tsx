import { cn } from '@/lib/utils'
import { priorityConfig, type Priority } from '@/data/sample-tasks'

// ============================================================================
// STATUS CIRCLE — Replaces TaskCheckbox with Linear-style SVG status indicator
// ============================================================================

interface StatusCircleProps {
  statusType: 'todo' | 'in_progress' | 'done'
  statusColor: string
  isCompleted: boolean
  onClick: (e: React.MouseEvent) => void
  className?: string
}

export const StatusCircle = ({
  statusType,
  statusColor,
  isCompleted,
  onClick,
  className
}: StatusCircleProps): React.JSX.Element => {
  const effectiveType = isCompleted ? 'done' : statusType

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'shrink-0 cursor-pointer rounded-full',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
      aria-label={isCompleted ? 'Mark as incomplete' : 'Mark as complete'}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
        {effectiveType === 'done' ? (
          <>
            <circle
              cx="8"
              cy="8"
              r="5.5"
              stroke={statusColor}
              strokeWidth="1.5"
              fill={statusColor}
            />
            <path
              d="M5.5 8l1.5 1.5L10.5 6"
              stroke="var(--background)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : effectiveType === 'in_progress' ? (
          <>
            <circle cx="8" cy="8" r="5.5" stroke={statusColor} strokeWidth="1.5" />
            <path d="M8 2.5A5.5 5.5 0 0 1 8 13.5" fill={statusColor} />
          </>
        ) : (
          <circle cx="8" cy="8" r="5.5" stroke="var(--text-tertiary)" strokeWidth="1.5" />
        )}
      </svg>
    </button>
  )
}

// ============================================================================
// PRIORITY BARS — Linear-style bar chart indicator
// ============================================================================

interface PriorityBarsProps {
  priority: Priority
  className?: string
}

export const PriorityBars = ({ priority, className }: PriorityBarsProps): React.JSX.Element => {
  if (priority === 'none') {
    return <div className={cn('w-[14px] shrink-0', className)} aria-hidden="true" />
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
