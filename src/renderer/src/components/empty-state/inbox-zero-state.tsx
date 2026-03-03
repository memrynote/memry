import { CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface InboxZeroStateProps {
  itemsProcessedToday: number
  onViewRecentActivity?: () => void
}

/**
 * Formats the processing stats message based on items processed today
 */
const getStatsMessage = (count: number): string => {
  if (count === 0) {
    return 'All caught up'
  }
  if (count === 1) {
    return 'You processed 1 item today'
  }
  return `You processed ${count} items today`
}

/**
 * Inbox Zero state - shown when user has cleared their inbox.
 * Displays a calm, understated celebration with processing stats.
 */
const InboxZeroState = ({
  itemsProcessedToday,
  onViewRecentActivity
}: InboxZeroStateProps): React.JSX.Element => {
  const statsMessage = getStatsMessage(itemsProcessedToday)

  return (
    <div className="flex flex-col items-center text-center max-w-md space-y-6">
      {/* Checkmark Icon - calm, muted color */}
      <div
        className={cn(
          'flex items-center justify-center',
          'size-16 rounded-full',
          'bg-primary/10',
          'empty-state-entrance stagger-delay-1',
          'motion-reduce:animate-none'
        )}
        aria-label="Success, inbox is empty"
      >
        <CheckCircle2 className="size-8 text-primary" strokeWidth={1.5} aria-hidden="true" />
      </div>

      {/* Title */}
      <h2
        className={cn(
          'text-2xl font-medium text-foreground',
          'empty-state-entrance stagger-delay-2',
          'motion-reduce:animate-none'
        )}
      >
        Inbox zero
      </h2>

      {/* Processing Stats */}
      <p
        className={cn(
          'text-sm text-muted-foreground',
          'empty-state-entrance stagger-delay-3',
          'motion-reduce:animate-none'
        )}
      >
        {statsMessage}
      </p>

      {/* Optional Action */}
      {onViewRecentActivity && (
        <Button
          variant="link"
          onClick={onViewRecentActivity}
          className={cn(
            'text-muted-foreground hover:text-foreground',
            'empty-state-entrance stagger-delay-4',
            'transition-colors duration-[var(--duration-fast)]',
            'motion-reduce:animate-none'
          )}
        >
          View recent activity
        </Button>
      )}
    </div>
  )
}

export { InboxZeroState }
