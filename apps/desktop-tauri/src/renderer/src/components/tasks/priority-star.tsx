import { cn } from '@/lib/utils'

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
