/**
 * AI Connections Panel Component
 * Shows semantic matches to related past entries based on current writing
 */

import { memo, useState } from 'react'
import {
  Zap,
  BookOpen,
  FileText,
  ChevronRight,
  RefreshCw,
  Sparkles,
  AlertCircle
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

// =============================================================================
// TYPES
// =============================================================================

export type ConnectionType = 'journal' | 'note' | 'page'

export interface AIConnection {
  id: string
  type: ConnectionType
  /** For journal entries - date string */
  date?: string
  /** For notes/pages - title */
  title?: string
  /** Preview snippet of content */
  preview: string
  /** Similarity score 0-1 */
  score: number
  /** Keywords that matched */
  matchedKeywords?: string[]
}

export interface AIConnectionsPanelProps {
  /** List of connections */
  connections: AIConnection[]
  /** Loading state */
  isLoading?: boolean
  /** Is initial analysis without any history */
  isNewUser?: boolean
  /** Error message if any */
  error?: string | null
  /** Callback when connection is clicked */
  onConnectionClick?: (connection: AIConnection) => void
  /** Callback to refresh connections */
  onRefresh?: () => void
  /** Max items to show before expand */
  maxItems?: number
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export const AIConnectionsPanel = memo(function AIConnectionsPanel({
  connections,
  isLoading = false,
  isNewUser = false,
  error = null,
  onConnectionClick,
  onRefresh,
  maxItems = 3
}: AIConnectionsPanelProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false)

  const visibleConnections = isExpanded ? connections : connections.slice(0, maxItems)

  const hiddenCount = connections.length - maxItems

  return (
    <div
      role="region"
      aria-label="AI Connections"
      aria-live="polite"
      className="rounded-lg border border-border/40 bg-card overflow-hidden"
    >
      {/* Header */}
      <PanelHeader
        count={connections.length}
        isLoading={isLoading}
        hasError={!!error}
        onRefresh={onRefresh}
      />

      {/* Content */}
      <div className="p-3">
        {/* Error State */}
        {error && <ErrorState message={error} onRetry={onRefresh} />}

        {/* Loading State (only if no connections yet) */}
        {isLoading && connections.length === 0 && !error && <LoadingState />}

        {/* Empty State */}
        {!isLoading && connections.length === 0 && !error && <EmptyState isNewUser={isNewUser} />}

        {/* Connections List */}
        {connections.length > 0 && !error && (
          <div className="flex flex-col gap-2">
            {visibleConnections.map((connection) => (
              <ConnectionItem
                key={connection.id}
                connection={connection}
                onClick={() => onConnectionClick?.(connection)}
              />
            ))}

            {/* Expand/Collapse Button */}
            {hiddenCount > 0 && (
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className={cn(
                  'w-full py-2 px-3 mt-1',
                  'text-sm text-muted-foreground hover:text-foreground',
                  'border border-dashed border-border/60 rounded-md',
                  'hover:bg-muted/50 transition-colors',
                  'flex items-center justify-center gap-1'
                )}
              >
                {isExpanded ? (
                  <>Show less</>
                ) : (
                  <>
                    + {hiddenCount} more connection{hiddenCount > 1 ? 's' : ''}
                  </>
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

// =============================================================================
// HEADER
// =============================================================================

interface PanelHeaderProps {
  count: number
  isLoading: boolean
  hasError: boolean
  onRefresh?: () => void
}

function PanelHeader({
  count,
  isLoading,
  hasError,
  onRefresh
}: PanelHeaderProps): React.JSX.Element {
  return (
    <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Zap className="size-4 text-accent-purple" />
        <span className="text-sm font-medium">AI Connections</span>

        {/* Loading spinner in header */}
        {isLoading && <RefreshCw className="size-3.5 text-muted-foreground animate-spin" />}

        {/* Error indicator */}
        {hasError && <AlertCircle className="size-3.5 text-destructive" />}
      </div>

      <div className="flex items-center gap-2">
        {/* Refresh button */}
        {onRefresh && !isLoading && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={onRefresh}
            title="Refresh connections"
          >
            <RefreshCw className="size-3.5" />
          </Button>
        )}

        {/* Count badge */}
        {count > 0 && <span className="text-xs text-muted-foreground">({count})</span>}
      </div>
    </div>
  )
}

// =============================================================================
// CONNECTION ITEM
// =============================================================================

interface ConnectionItemProps {
  connection: AIConnection
  onClick?: () => void
}

function ConnectionItem({ connection, onClick }: ConnectionItemProps): React.JSX.Element {
  const Icon = connection.type === 'journal' ? BookOpen : FileText
  const label = connection.type === 'journal' ? connection.date : connection.title

  // Format score as percentage
  const scorePercent = Math.round(connection.score * 100)

  // Determine score color
  const scoreColor =
    scorePercent >= 90
      ? 'text-green-600 dark:text-green-400'
      : scorePercent >= 75
        ? 'text-blue-600 dark:text-blue-400'
        : 'text-muted-foreground'

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left p-3 rounded-lg',
        'bg-muted/30 hover:bg-muted/60',
        'border border-transparent hover:border-border/40',
        'transition-all duration-150',
        'group cursor-pointer'
      )}
      aria-label={`Connection to ${label}, ${scorePercent}% match`}
    >
      {/* Top row: Icon + Label + Percentage */}
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Icon className="size-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium text-foreground truncate">{label}</span>
        </div>

        {/* Percentage in upper right corner */}
        <span className={cn('text-xs font-medium shrink-0', scoreColor)}>{scorePercent}%</span>
      </div>

      {/* Preview text */}
      <p className="text-xs text-muted-foreground line-clamp-2 mb-2 pl-6 italic">
        "{connection.preview}"
      </p>

      {/* Bottom row: Arrow only */}
      <div className="flex items-center justify-end pl-6">
        <ChevronRight className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </button>
  )
}

// =============================================================================
// STATE COMPONENTS
// =============================================================================

function LoadingState(): React.JSX.Element {
  return (
    <div className="py-8 flex flex-col items-center justify-center text-center">
      <div className="flex gap-1 mb-3">
        <span
          className="size-2 bg-muted-foreground/40 rounded-full animate-bounce"
          style={{ animationDelay: '0ms' }}
        />
        <span
          className="size-2 bg-muted-foreground/40 rounded-full animate-bounce"
          style={{ animationDelay: '150ms' }}
        />
        <span
          className="size-2 bg-muted-foreground/40 rounded-full animate-bounce"
          style={{ animationDelay: '300ms' }}
        />
      </div>
      <p className="text-sm text-muted-foreground">Analyzing your entry...</p>
    </div>
  )
}

function EmptyState({ isNewUser }: { isNewUser: boolean }): React.JSX.Element {
  return (
    <div className="py-8 flex flex-col items-center justify-center text-center">
      <Sparkles className="size-8 text-muted-foreground/40 mb-3" />
      <p className="text-sm font-medium text-muted-foreground mb-1">
        {isNewUser ? 'Your connections will appear here' : 'No connections found yet'}
      </p>
      <p className="text-xs text-muted-foreground/70">
        {isNewUser
          ? 'As you journal more, AI will find related entries'
          : 'Keep writing to discover related entries'}
      </p>
    </div>
  )
}

interface ErrorStateProps {
  message: string
  onRetry?: () => void
}

function ErrorState({ message, onRetry }: ErrorStateProps): React.JSX.Element {
  return (
    <div className="py-6 flex flex-col items-center justify-center text-center">
      <AlertCircle className="size-8 text-destructive/60 mb-3" />
      <p className="text-sm text-muted-foreground mb-3">{message || "Couldn't load connections"}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try Again
        </Button>
      )}
    </div>
  )
}

export default AIConnectionsPanel
