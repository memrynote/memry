import { CheckCircle, Search } from 'lucide-react'

import { cn } from '@/lib/utils'

// ============================================================================
// TYPES
// ============================================================================

interface CompletedEmptyStateProps {
  variant?: 'no-completed' | 'no-results'
  searchQuery?: string
  className?: string
}

// ============================================================================
// COMPLETED EMPTY STATE
// ============================================================================

export const CompletedEmptyState = ({
  variant = 'no-completed',
  searchQuery,
  className
}: CompletedEmptyStateProps): React.JSX.Element => {
  // No search results
  if (variant === 'no-results') {
    return (
      <div className={cn('text-center py-16', className)}>
        <div className="mb-4 rounded-full bg-muted p-4 inline-block">
          <Search className="size-8 text-text-tertiary" aria-hidden="true" />
        </div>
        <h3 className="text-lg font-medium text-text-primary mb-2">No results found</h3>
        <p className="text-sm text-text-tertiary max-w-xs mx-auto">
          No completed tasks match &quot;{searchQuery}&quot;. Try a different search term.
        </p>
      </div>
    )
  }

  // No completed tasks
  return (
    <div className={cn('text-center py-16', className)}>
      <div className="mb-4 rounded-full bg-muted p-4 inline-block">
        <CheckCircle className="size-8 text-text-tertiary" aria-hidden="true" />
      </div>
      <h3 className="text-lg font-medium text-text-primary mb-2">No completed tasks yet</h3>
      <p className="text-sm text-text-tertiary max-w-xs mx-auto">
        Tasks you complete will appear here. Start checking things off your list!
      </p>
    </div>
  )
}

export default CompletedEmptyState
