/**
 * Folder View Empty State Component
 *
 * Displays appropriate empty states for the folder view:
 * - 'empty': No notes in folder - shows create note CTA
 * - 'no-results': Search/filter yielded no results - shows clear all CTA
 * - 'error': Error occurred - shows retry CTA
 */

import {
  FolderOpen,
  Search,
  AlertCircle,
  Plus,
  RefreshCw,
  X,
  FolderX,
  ArrowLeft
} from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// ============================================================================
// Types
// ============================================================================

export type FolderViewEmptyStateVariant = 'empty' | 'no-results' | 'error' | 'folder-not-found'

export interface FolderViewEmptyStateProps {
  /** Which variant to display */
  variant: FolderViewEmptyStateVariant

  /** Error message (for 'error' variant) */
  errorMessage?: string

  /** Called when user clicks "Create Note" ('empty' variant) */
  onCreateNote?: () => void

  /** Called when user clicks "Clear all" ('no-results' variant) */
  onClearAll?: () => void

  /** Called when user clicks "Try again" ('error' variant) */
  onRetry?: () => void

  /** Called when user clicks "Go Back" ('folder-not-found' variant) */
  onGoBack?: () => void

  /** Additional CSS classes */
  className?: string
}

// ============================================================================
// Configuration
// ============================================================================

interface EmptyStateConfig {
  icon: React.ElementType
  iconClassName?: string
  containerClassName?: string
  title: string
  description: string
  actionLabel?: string
  actionIcon?: React.ElementType
  actionVariant?: 'default' | 'outline' | 'destructive'
}

const emptyStateConfigs: Record<FolderViewEmptyStateVariant, EmptyStateConfig> = {
  empty: {
    icon: FolderOpen,
    iconClassName: 'text-muted-foreground',
    containerClassName: 'bg-muted',
    title: 'No notes in this folder',
    description: 'Create a new note to get started',
    actionLabel: 'Create Note',
    actionIcon: Plus,
    actionVariant: 'default'
  },
  'no-results': {
    icon: Search,
    iconClassName: 'text-muted-foreground',
    containerClassName: 'bg-muted',
    title: 'No matching notes',
    description: 'Adjust your search or filters',
    actionLabel: 'Clear all',
    actionIcon: X,
    actionVariant: 'outline'
  },
  error: {
    icon: AlertCircle,
    iconClassName: 'text-destructive',
    containerClassName: 'bg-destructive/10',
    title: 'Something went wrong',
    description: 'Unable to load folder contents',
    actionLabel: 'Try again',
    actionIcon: RefreshCw,
    actionVariant: 'default'
  },
  'folder-not-found': {
    icon: FolderX,
    iconClassName: 'text-muted-foreground',
    containerClassName: 'bg-muted',
    title: 'Folder not found',
    description: 'This folder may have been moved or deleted',
    actionLabel: 'Go Back',
    actionIcon: ArrowLeft,
    actionVariant: 'outline'
  }
}

// ============================================================================
// Component
// ============================================================================

/**
 * Empty state component for folder view with different variants.
 */
export function FolderViewEmptyState({
  variant,
  errorMessage,
  onCreateNote,
  onClearAll,
  onRetry,
  onGoBack,
  className
}: FolderViewEmptyStateProps): React.JSX.Element {
  const config = emptyStateConfigs[variant]
  const Icon = config.icon
  const ActionIcon = config.actionIcon

  // Determine action handler based on variant
  const handleAction = (): void => {
    switch (variant) {
      case 'empty':
        onCreateNote?.()
        break
      case 'no-results':
        onClearAll?.()
        break
      case 'error':
        onRetry?.()
        break
      case 'folder-not-found':
        onGoBack?.()
        break
    }
  }

  // Determine if action button should be shown
  const showAction =
    (variant === 'empty' && onCreateNote) ||
    (variant === 'no-results' && onClearAll) ||
    (variant === 'error' && onRetry) ||
    (variant === 'folder-not-found' && onGoBack)

  // Use custom error message if provided
  const description = variant === 'error' && errorMessage ? errorMessage : config.description

  return (
    <div
      className={cn('flex flex-col items-center justify-center py-16 px-4 text-center', className)}
      role="status"
      aria-live="polite"
    >
      {/* Icon */}
      <div className={cn('mb-4 rounded-full p-4', config.containerClassName)} aria-hidden="true">
        <Icon className={cn('size-8', config.iconClassName)} strokeWidth={1.5} />
      </div>

      {/* Title */}
      <h3 className="mb-2 text-lg font-medium text-foreground">{config.title}</h3>

      {/* Description */}
      <p className="mb-6 max-w-sm text-sm text-muted-foreground">{description}</p>

      {/* Action Button */}
      {showAction && config.actionLabel && (
        <Button variant={config.actionVariant} onClick={handleAction} className="gap-2">
          {ActionIcon && <ActionIcon className="size-4" aria-hidden="true" />}
          {config.actionLabel}
        </Button>
      )}
    </div>
  )
}

export default FolderViewEmptyState
