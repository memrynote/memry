import { Star } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface StreakBadgeProps {
  streak: number
  size?: 'sm' | 'md'
  className?: string
}

export function StreakBadge({
  streak,
  size = 'sm',
  className
}: StreakBadgeProps): React.JSX.Element | null {
  if (streak <= 0) return null

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 rounded-xl font-medium tabular-nums',
        size === 'sm' && 'px-2.5 py-0.5 text-[11px]/3.5',
        size === 'md' && 'px-3 py-1 text-sm',
        'bg-tint/10 text-tint',
        className
      )}
      title={`${streak} day processing streak`}
    >
      <Star className={cn(size === 'sm' ? 'size-3' : 'size-3.5')} />
      <span>{streak} streak</span>
    </div>
  )
}
