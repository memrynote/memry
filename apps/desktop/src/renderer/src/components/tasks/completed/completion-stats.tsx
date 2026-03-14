import { Flame, CheckCircle, Calendar, TrendingUp } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { CompletionStats as CompletionStatsType } from '@/lib/task-utils'

// ============================================================================
// TYPES
// ============================================================================

interface CompletionStatsProps {
  stats: CompletionStatsType
  className?: string
}

interface StatCardProps {
  label: string
  value: number
  icon: React.ReactNode
  variant?: 'default' | 'accent'
  className?: string
}

// ============================================================================
// STAT CARD
// ============================================================================

const StatCard = ({
  label,
  value,
  icon,
  variant = 'default',
  className
}: StatCardProps): React.JSX.Element => {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-sm border px-4 py-3',
        variant === 'default' && 'border-border bg-background',
        variant === 'accent' &&
          'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30',
        className
      )}
      role="status"
      aria-label={`${label}: ${value}`}
    >
      <div
        className={cn(
          'flex size-9 items-center justify-center rounded-sm',
          variant === 'default' && 'bg-muted',
          variant === 'accent' && 'bg-emerald-100 dark:bg-emerald-900/50'
        )}
      >
        {icon}
      </div>
      <div className="flex flex-col">
        <span
          className={cn(
            'text-lg font-semibold tabular-nums',
            variant === 'default' && 'text-text-primary',
            variant === 'accent' && 'text-emerald-700 dark:text-emerald-400'
          )}
        >
          {value}
        </span>
        <span className="text-xs text-text-tertiary">{label}</span>
      </div>
    </div>
  )
}

// ============================================================================
// COMPLETION STATS PANEL
// ============================================================================

export const CompletionStats = ({ stats, className }: CompletionStatsProps): React.JSX.Element => {
  return (
    <div
      className={cn('grid grid-cols-4 gap-3', className)}
      role="region"
      aria-label="Completion statistics"
    >
      <StatCard
        label="Today"
        value={stats.today}
        variant="accent"
        icon={
          <CheckCircle
            className="size-5 text-emerald-600 dark:text-emerald-400"
            aria-hidden="true"
          />
        }
      />
      <StatCard
        label="This Week"
        value={stats.thisWeek}
        icon={<Calendar className="size-5 text-text-tertiary" aria-hidden="true" />}
      />
      <StatCard
        label="This Month"
        value={stats.thisMonth}
        icon={<TrendingUp className="size-5 text-text-tertiary" aria-hidden="true" />}
      />
      <StatCard
        label="Day Streak"
        value={stats.streak}
        variant={stats.streak >= 3 ? 'accent' : 'default'}
        icon={
          <Flame
            className={cn('size-5', stats.streak >= 3 ? 'text-orange-500' : 'text-text-tertiary')}
            aria-hidden="true"
          />
        }
      />
    </div>
  )
}

export default CompletionStats
