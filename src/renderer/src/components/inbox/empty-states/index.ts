/**
 * Empty States Index
 *
 * Export all empty state components.
 */

// Dispatcher
export {
  EmptyState,
  type EmptyStateProps,
  type EmptyStateType,
  type EmptyStateContext,
} from './empty-state'

// Individual states
export { GettingStarted, type GettingStartedProps } from './getting-started'
export {
  InboxZero,
  type InboxZeroProps,
  type InboxZeroStats,
} from './inbox-zero'
export {
  ReturningEmpty,
  type ReturningEmptyProps,
  type SnoozedItemPreview,
} from './returning-empty'
