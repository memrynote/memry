import { InboxZeroState } from '@/components/empty-state/inbox-zero-state'
import { cn } from '@/lib/utils'

interface EmptyStateProps {
  itemsProcessedToday: number
  processedThisWeek: number
  currentStreak: number
  isExiting?: boolean
  className?: string
}

const EmptyState = ({
  itemsProcessedToday,
  processedThisWeek,
  currentStreak,
  isExiting = false,
  className
}: EmptyStateProps): React.JSX.Element => {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center h-full w-full px-4',
        'transition-all duration-150 ease-out',
        isExiting
          ? 'opacity-0 scale-95 motion-reduce:opacity-0 motion-reduce:scale-100'
          : 'opacity-100 scale-100 animate-in fade-in duration-300 motion-reduce:animate-none',
        className
      )}
      role="status"
      aria-live="polite"
    >
      <InboxZeroState
        itemsProcessedToday={itemsProcessedToday}
        processedThisWeek={processedThisWeek}
        currentStreak={currentStreak}
      />
    </div>
  )
}

export { EmptyState }
