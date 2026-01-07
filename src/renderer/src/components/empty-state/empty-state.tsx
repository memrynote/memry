import { InboxZeroState } from '@/components/empty-state/inbox-zero-state'
import { GettingStartedState } from '@/components/empty-state/getting-started-state'
import { cn } from '@/lib/utils'

export type EmptyStateVariant = 'inboxZero' | 'gettingStarted'

interface EmptyStateProps {
  itemsProcessedToday: number
  hasFilingHistory: boolean
  isExiting?: boolean
  className?: string
}

/**
 * Determines which empty state variant to show based on user history
 */
const getVariant = (hasFilingHistory: boolean, itemsProcessedToday: number): EmptyStateVariant => {
  // If user has processed items this session or has filing history, show celebration
  if (hasFilingHistory || itemsProcessedToday > 0) {
    return 'inboxZero'
  }
  // Otherwise, show onboarding
  return 'gettingStarted'
}

/**
 * Empty State container component that selects the appropriate variant
 * based on user history and displays the corresponding UI.
 */
const EmptyState = ({
  itemsProcessedToday,
  hasFilingHistory,
  isExiting = false,
  className
}: EmptyStateProps): React.JSX.Element => {
  const variant = getVariant(hasFilingHistory, itemsProcessedToday)

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center h-full w-full px-4',
        'transition-all duration-150 ease-out',
        // Entrance/exit animations
        isExiting
          ? 'opacity-0 scale-95 motion-reduce:opacity-0 motion-reduce:scale-100'
          : 'opacity-100 scale-100 animate-in fade-in duration-300 motion-reduce:animate-none',
        className
      )}
      role="status"
      aria-live="polite"
    >
      {variant === 'inboxZero' ? (
        <InboxZeroState itemsProcessedToday={itemsProcessedToday} />
      ) : (
        <GettingStartedState />
      )}
    </div>
  )
}

export { EmptyState }
