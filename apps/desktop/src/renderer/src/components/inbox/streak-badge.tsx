import { Flame } from '@/lib/icons'
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

  const isHot = streak >= 7
  const isBurning = streak >= 14

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1 rounded-full font-medium tabular-nums',
        size === 'sm' && 'px-2 py-0.5 text-xs',
        size === 'md' && 'px-3 py-1 text-sm',
        isBurning
          ? 'bg-orange-500/15 text-orange-600 dark:text-orange-400'
          : isHot
            ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
            : 'bg-muted text-muted-foreground',
        className
      )}
      title={`${streak} day processing streak`}
    >
      <Flame
        className={cn(
          size === 'sm' ? 'size-3' : 'size-3.5',
          isBurning && 'animate-pulse',
          isBurning ? 'text-orange-500' : isHot ? 'text-amber-500' : 'text-muted-foreground/70'
        )}
      />
      <span>{streak}d</span>
    </div>
  )
}
