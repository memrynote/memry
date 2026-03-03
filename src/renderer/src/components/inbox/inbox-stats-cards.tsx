import {
  Clock,
  CheckCircle,
  AlertCircle,
  Inbox,
  TrendingUp,
  TrendingDown,
  Minus
} from 'lucide-react'
import type { InboxStats } from '../../../../preload/index.d'
import { cn } from '@/lib/utils'

export interface InboxStatsCardsProps {
  stats: InboxStats | null
}

function formatDuration(ms: number): string {
  if (ms === 0) return '0s'
  if (ms < 1000) return '<1s'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function InboxStatsCards({ stats }: InboxStatsCardsProps): React.JSX.Element {
  if (!stats) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-24 bg-muted/50 rounded-xl animate-pulse" />
        ))}
      </div>
    )
  }

  const cards = [
    {
      label: 'Total Items',
      value: stats.totalItems,
      icon: Inbox,
      trend: stats.capturedToday > 0 ? 'up' : 'neutral',
      trendValue: `+${stats.capturedToday} today`,
      iconColor: 'text-muted-foreground'
    },
    {
      label: 'Processed Today',
      value: stats.processedToday,
      icon: CheckCircle,
      trend: 'up',
      trendValue: 'Completed',
      iconColor: 'text-primary'
    },
    {
      label: 'Avg Processing Time',
      value: formatDuration(stats.avgTimeToProcess),
      icon: Clock,
      trend: 'neutral',
      trendValue: 'Average',
      iconColor: 'text-amber-600 dark:text-amber-400'
    },
    {
      label: 'Stale Items',
      value: stats.staleCount,
      icon: AlertCircle,
      trend: stats.staleCount > 5 ? 'down' : 'neutral',
      trendValue: 'Needs attention',
      iconColor: 'text-destructive'
    }
  ] as const

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card, index) => (
        <div
          key={index}
          className={cn(
            'p-4 rounded-xl border border-border/50',
            'flex flex-col justify-between h-28',
            'bg-card transition-colors hover:bg-accent/30'
          )}
        >
          <div className="flex justify-between items-start">
            <span className="text-sm font-medium font-serif text-muted-foreground tracking-wide">
              {card.label}
            </span>
            <div className="p-1.5 rounded-full bg-muted/50">
              <card.icon className={cn('size-4', card.iconColor)} />
            </div>
          </div>

          <div className="flex items-end justify-between">
            <span className="text-3xl font-bold font-display text-foreground tracking-tight">
              {card.value}
            </span>

            <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
              {card.trend === 'up' && <TrendingUp className="size-3" />}
              {card.trend === 'down' && <TrendingDown className="size-3" />}
              {card.trend === 'neutral' && <Minus className="size-3" />}
              <span className="opacity-80">{card.trendValue}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
