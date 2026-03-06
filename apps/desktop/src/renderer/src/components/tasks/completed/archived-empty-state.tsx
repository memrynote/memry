import { Archive, Search } from 'lucide-react'

import { cn } from '@/lib/utils'

// ============================================================================
// TYPES
// ============================================================================

interface ArchivedEmptyStateProps {
  variant?: 'no-archived' | 'no-results'
  searchQuery?: string
  className?: string
}

// ============================================================================
// ARCHIVED EMPTY STATE
// ============================================================================

export const ArchivedEmptyState = ({
  variant = 'no-archived',
  searchQuery,
  className
}: ArchivedEmptyStateProps): React.JSX.Element => {
  // No search results
  if (variant === 'no-results') {
    return (
      <div className={cn('text-center py-16', className)}>
        <div className="mb-4 rounded-full bg-muted p-4 inline-block">
          <Search className="size-8 text-text-tertiary" aria-hidden="true" />
        </div>
        <h3 className="text-lg font-medium text-text-primary mb-2">No results found</h3>
        <p className="text-sm text-text-tertiary max-w-xs mx-auto">
          No archived tasks match &quot;{searchQuery}&quot;. Try a different search term.
        </p>
      </div>
    )
  }

  // No archived tasks
  return (
    <div className={cn('text-center py-16', className)}>
      <div className="mb-4 rounded-full bg-muted p-4 inline-block">
        <Archive className="size-8 text-text-tertiary" aria-hidden="true" />
      </div>
      <h3 className="text-lg font-medium text-text-primary mb-2">No archived tasks</h3>
      <p className="text-sm text-text-tertiary max-w-xs mx-auto">
        Tasks you archive will appear here. Archive completed tasks to keep your list tidy.
      </p>
    </div>
  )
}

export default ArchivedEmptyState
