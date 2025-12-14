/**
 * Empty State Dispatcher
 *
 * Selects and renders the appropriate empty state based on:
 * - Getting Started: No history at all
 * - Inbox Zero: Has history, processed items today
 * - Returning Empty: Has history, no processing today
 */
import { GettingStarted, type GettingStartedProps } from './getting-started'
import { InboxZero, type InboxZeroStats, type InboxZeroProps } from './inbox-zero'
import { ReturningEmpty, type SnoozedItemPreview, type ReturningEmptyProps } from './returning-empty'

// =============================================================================
// TYPES
// =============================================================================

export type EmptyStateType = 'getting-started' | 'inbox-zero' | 'returning'

export interface EmptyStateContext {
  /** Whether user has ever filed or deleted items */
  hasHistory: boolean
  /** Number of items processed today */
  processedToday: number
  /** Stats for Inbox Zero state */
  stats?: InboxZeroStats
  /** Snoozed items for Returning state */
  snoozedItems?: SnoozedItemPreview[]
}

export interface EmptyStateProps {
  /** Context to determine which state to show */
  context: EmptyStateContext
  /** Callback when user wants to capture a new item */
  onCapture?: () => void
  /** Callback to view snoozed items */
  onViewSnoozed?: () => void
  /** Additional class names */
  className?: string
}

// =============================================================================
// STATE SELECTION LOGIC
// =============================================================================

function determineEmptyState(context: EmptyStateContext): EmptyStateType {
  const { hasHistory, processedToday } = context

  // Brand new user - never captured anything
  if (!hasHistory) {
    return 'getting-started'
  }

  // User has processed items today - celebrate!
  if (processedToday > 0) {
    return 'inbox-zero'
  }

  // User has history but nothing processed today
  return 'returning'
}

// =============================================================================
// COMPONENT
// =============================================================================

export function EmptyState({
  context,
  onCapture,
  onViewSnoozed,
  className,
}: EmptyStateProps): React.JSX.Element {
  const stateType = determineEmptyState(context)

  switch (stateType) {
    case 'getting-started':
      return <GettingStarted onCapture={onCapture} className={className} />

    case 'inbox-zero':
      return (
        <InboxZero
          stats={
            context.stats || {
              processedToday: context.processedToday,
              filedToday: 0,
              deletedToday: 0,
              snoozedToday: 0,
            }
          }
          onCapture={onCapture}
          className={className}
        />
      )

    case 'returning':
      return (
        <ReturningEmpty
          snoozedItems={context.snoozedItems}
          onCapture={onCapture}
          onViewSnoozed={onViewSnoozed}
          className={className}
        />
      )
  }
}

// =============================================================================
// CONVENIENCE EXPORTS
// =============================================================================

export type { GettingStartedProps, InboxZeroProps, InboxZeroStats, ReturningEmptyProps, SnoozedItemPreview }
