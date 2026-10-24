import { cn } from '@/lib/utils'
import type { Priority } from '@/data/task-model'

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
