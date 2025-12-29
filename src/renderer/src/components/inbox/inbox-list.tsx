/**
 * InboxList Components
 *
 * Reusable list components for inbox items with multi-selection support,
 * collapsible time-based sections, and editorial styling.
 * Matches the design pattern from template-selector.
 */

import { useState, useEffect, createContext, useContext } from 'react'
import {
  ChevronRight,
  Link,
  FileText,
  Image,
  Mic,
  Scissors,
  FileIcon,
  Share2,
  Loader2,
  AlertCircle,
  RotateCcw,
  Clock
} from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { QuickActions } from '@/components/quick-actions'
import { InlineQuickFile } from '@/components/inline-quick-file'
import { QuickFileDropdown, getFilteredFolders } from '@/components/quick-file-dropdown'
import { formatSnoozeReturn } from '@/components/snooze'
import { formatTimestamp, formatDuration, type TimePeriod } from '@/lib/inbox-utils'
import { cn } from '@/lib/utils'
import type { InboxItemListItem, InboxItemType, Folder } from '@/types'

type InboxItem = InboxItemListItem

// ============================================================================
// Context for selection and focus state
// ============================================================================

interface InboxListContextValue {
  selectedIds: Set<string>
  focusedId: string | null
  isInBulkMode: boolean
  onSelect: (id: string, shiftKey: boolean) => void
  onFocus: (id: string) => void
}

const InboxListContext = createContext<InboxListContextValue | null>(null)

function useInboxList() {
  const context = useContext(InboxListContext)
  if (!context) {
    throw new Error('InboxListItem must be used within an InboxListSection')
  }
  return context
}

// ============================================================================
// Type Icon - matches the inbox item type
// ============================================================================

const TypeIcon = ({ type }: { type: InboxItemType }): React.JSX.Element => {
  const iconClass = 'w-4 h-4 text-muted-foreground/60'

  switch (type) {
    case 'link':
      return <Link className={iconClass} aria-hidden="true" />
    case 'note':
      return <FileText className={iconClass} aria-hidden="true" />
    case 'image':
      return <Image className={iconClass} aria-hidden="true" />
    case 'voice':
      return <Mic className={iconClass} aria-hidden="true" />
    case 'clip':
      return <Scissors className={iconClass} aria-hidden="true" />
    case 'pdf':
      return <FileIcon className={iconClass} aria-hidden="true" />
    case 'social':
      return <Share2 className={iconClass} aria-hidden="true" />
    default:
      return <FileText className={iconClass} aria-hidden="true" />
  }
}

// ============================================================================
// Transcription Status Badge
// ============================================================================

interface TranscriptionStatusProps {
  item: InboxItem
  onRetry?: (itemId: string) => void
}

const TranscriptionStatus = ({
  item,
  onRetry
}: TranscriptionStatusProps): React.JSX.Element | null => {
  if (item.type !== 'voice') return null

  const status = item.transcriptionStatus

  if (status === 'complete' && item.transcription) {
    const truncated =
      item.transcription.length > 60
        ? item.transcription.substring(0, 60) + '...'
        : item.transcription
    return (
      <span className="text-xs text-muted-foreground/60 italic truncate max-w-[200px]">
        "{truncated}"
      </span>
    )
  }

  if (status === 'pending' || status === 'processing') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-500">
        <Loader2 className="w-3 h-3 animate-spin" />
        <span>Transcribing...</span>
      </span>
    )
  }

  if (status === 'failed') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-destructive/70">
        <AlertCircle className="w-3 h-3" />
        <span>Transcription failed</span>
        {onRetry && (
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-xs hover:text-amber-600"
            onClick={(e) => {
              e.stopPropagation()
              onRetry(item.id)
            }}
          >
            <RotateCcw className="w-3 h-3 mr-1" />
            Retry
          </Button>
        )}
      </span>
    )
  }

  return null
}

// ============================================================================
// Item Thumbnail - for image items
// ============================================================================

const ItemThumbnail = ({ item }: { item: InboxItem }): React.JSX.Element | null => {
  const [imageError, setImageError] = useState(false)

  useEffect(() => {
    setImageError(false)
  }, [item.thumbnailUrl])

  if (item.type !== 'image' || !item.thumbnailUrl || imageError) {
    return null
  }

  return (
    <div className="w-9 h-9 rounded-lg overflow-hidden bg-muted shrink-0 ring-1 ring-border/50">
      <img
        src={item.thumbnailUrl}
        alt=""
        className="w-full h-full object-cover"
        onError={() => setImageError(true)}
        loading="lazy"
      />
    </div>
  )
}

// ============================================================================
// InboxListSection - Collapsible section with header (like SelectableListSection)
// ============================================================================

export interface InboxListSectionProps {
  /** Section title (e.g., "Today", "Yesterday") */
  title: string
  /** Optional icon before title */
  icon?: React.ReactNode
  /** Number of items (shown as count badge) */
  count?: number
  /** If true, section can be collapsed */
  collapsible?: boolean
  /** Default collapsed state (only if collapsible) */
  defaultCollapsed?: boolean
  /** Currently selected item IDs */
  selectedIds: Set<string>
  /** Currently focused item ID */
  focusedId: string | null
  /** Callback when an item is selected (with shift key support) */
  onSelect: (id: string, shiftKey: boolean) => void
  /** Callback when an item is focused */
  onFocus: (id: string) => void
  /** Section content (InboxListItem components) */
  children: React.ReactNode
  /** Additional class names */
  className?: string
}

export function InboxListSection({
  title,
  icon,
  count,
  collapsible = false,
  defaultCollapsed = false,
  selectedIds,
  focusedId,
  onSelect,
  onFocus,
  children,
  className
}: InboxListSectionProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed)
  const isInBulkMode = selectedIds.size > 0

  return (
    <InboxListContext.Provider value={{ selectedIds, focusedId, isInBulkMode, onSelect, onFocus }}>
      <section className={className} aria-labelledby={`section-${title.toLowerCase().replace(/\s/g, '-')}`}>
        <button
          type="button"
          onClick={() => collapsible && setIsCollapsed(!isCollapsed)}
          className={cn(
            'flex items-center gap-2 mb-2.5 w-full text-left',
            collapsible && 'cursor-pointer group'
          )}
          disabled={!collapsible}
          id={`section-${title.toLowerCase().replace(/\s/g, '-')}`}
        >
          {collapsible && (
            <ChevronRight
              className={cn(
                'w-3.5 h-3.5 text-muted-foreground/40 transition-transform duration-200',
                'group-hover:text-amber-600 dark:group-hover:text-amber-500',
                !isCollapsed && 'rotate-90'
              )}
            />
          )}
          {icon && (
            <span className="text-amber-600 dark:text-amber-500">{icon}</span>
          )}
          <h3
            className={cn(
              'text-xs font-semibold uppercase tracking-wider text-muted-foreground/60',
              collapsible && 'group-hover:text-amber-600 dark:group-hover:text-amber-500',
              'transition-colors'
            )}
          >
            {title}
          </h3>
          {count !== undefined && (
            <span className="text-xs text-muted-foreground/40 tabular-nums">{count}</span>
          )}
          <div className="flex-1 h-px bg-gradient-to-r from-amber-200/30 dark:from-amber-800/30 to-transparent" />
        </button>

        {!isCollapsed && <div className="space-y-0.5">{children}</div>}
      </section>
    </InboxListContext.Provider>
  )
}

// ============================================================================
// InboxListItem - Selectable row with checkbox (like SelectableListItem but multi-select)
// ============================================================================

export interface InboxListItemProps {
  /** The inbox item */
  item: InboxItem
  /** Time period for timestamp formatting */
  period: TimePeriod
  /** Whether the item is exiting (animating out) */
  isExiting?: boolean
  /** Whether Quick-File is active on this item */
  isQuickFileActive?: boolean
  /** Quick-File query string */
  quickFileQuery?: string
  /** Quick-File highlighted index */
  quickFileHighlightedIndex?: number
  /** Available folders for Quick-File */
  folders?: Folder[]
  /** Callbacks */
  onFile: (id: string) => void
  onPreview: (id: string) => void
  onDelete: (id: string) => void
  onSnooze?: (id: string, snoozeUntil: string) => void
  onQuickFileQueryChange?: (query: string) => void
  onQuickFileSubmit?: () => void
  onQuickFileCancel?: () => void
  onQuickFileArrowDown?: () => void
  onQuickFileArrowUp?: () => void
  onQuickFileFolderSelect?: (folder: Folder) => void
  onRetryTranscription?: (id: string) => void
  /** Additional class names */
  className?: string
}

export function InboxListItem({
  item,
  period,
  isExiting = false,
  isQuickFileActive = false,
  quickFileQuery = '',
  quickFileHighlightedIndex = 0,
  folders = [],
  onFile,
  onPreview,
  onDelete,
  onSnooze,
  onQuickFileQueryChange,
  onQuickFileSubmit,
  onQuickFileCancel,
  onQuickFileArrowDown,
  onQuickFileArrowUp,
  onQuickFileFolderSelect,
  onRetryTranscription,
  className
}: InboxListItemProps) {
  const { selectedIds, focusedId, isInBulkMode, onSelect, onFocus } = useInboxList()
  const isSelected = selectedIds.has(item.id)
  const isFocused = focusedId === item.id

  const filteredFolders = getFilteredFolders(folders, quickFileQuery, 5)

  const displayTitle =
    item.type === 'voice' && item.duration
      ? `${item.title} · ${formatDuration(item.duration)}`
      : item.title

  const handleClick = (): void => {
    onFocus(item.id)
  }

  const handleCheckboxClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onSelect(item.id, e.shiftKey)
  }

  return (
    <div
      className={cn(
        'group relative w-full',
        'flex items-center gap-3',
        'px-3 py-2.5 rounded-lg',
        'transition-all duration-150 ease-out',
        'cursor-pointer',
        // Exit animation
        isExiting && 'item-removing',
        // Base hover state
        'hover:bg-muted/50',
        // Selected state - warm amber
        isSelected && [
          'bg-amber-50 dark:bg-amber-950/30',
          'hover:bg-amber-50 dark:hover:bg-amber-950/30',
          'ring-1 ring-inset ring-amber-200 dark:ring-amber-800/50'
        ],
        // Focused state (not selected)
        !isSelected && isFocused && [
          'bg-muted',
          'ring-2 ring-inset ring-amber-400/50 dark:ring-amber-600/50'
        ],
        className
      )}
      role="listitem"
      tabIndex={isFocused ? 0 : -1}
      aria-label={`${item.type}: ${displayTitle}`}
      aria-selected={isSelected}
      onClick={handleClick}
      data-item-id={item.id}
    >
      {/* Checkbox with amber styling */}
      <div
        className={cn(
          'flex-shrink-0 transition-opacity duration-150',
          isSelected || isInBulkMode || isFocused
            ? 'opacity-100'
            : 'opacity-0 group-hover:opacity-100'
        )}
      >
        <Checkbox
          id={`inbox-item-${item.id}`}
          checked={isSelected}
          onCheckedChange={() => {}}
          className={cn(
            'border-muted-foreground/30',
            'data-[state=checked]:bg-amber-600 data-[state=checked]:border-amber-600',
            'dark:data-[state=checked]:bg-amber-500 dark:data-[state=checked]:border-amber-500',
            'transition-colors'
          )}
          aria-label={`Select ${displayTitle}`}
          onClick={handleCheckboxClick}
        />
      </div>

      {/* Icon or Thumbnail */}
      <div
        className={cn(
          'flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center',
          'transition-colors duration-150',
          isSelected ? 'bg-amber-100 dark:bg-amber-900/40' : 'bg-muted/60 dark:bg-muted/40',
          'group-hover:bg-muted dark:group-hover:bg-muted/60'
        )}
      >
        {item.type === 'image' && item.thumbnailUrl ? (
          <ItemThumbnail item={item} />
        ) : (
          <TypeIcon type={item.type} />
        )}
      </div>

      {/* Content area - shows title or Quick-File input */}
      {isQuickFileActive && onQuickFileFolderSelect ? (
        <>
          <span className="text-sm text-foreground/90 truncate max-w-[40%] shrink-0 font-medium">
            {displayTitle}
          </span>
          <InlineQuickFile
            query={quickFileQuery}
            onQueryChange={onQuickFileQueryChange || (() => {})}
            onSubmit={onQuickFileSubmit || (() => {})}
            onCancel={onQuickFileCancel || (() => {})}
            onArrowDown={onQuickFileArrowDown || (() => {})}
            onArrowUp={onQuickFileArrowUp || (() => {})}
            filteredFolders={filteredFolders}
            onFolderSelect={onQuickFileFolderSelect}
          />
          <QuickFileDropdown
            folders={folders}
            query={quickFileQuery}
            highlightedIndex={quickFileHighlightedIndex}
            onSelect={onQuickFileFolderSelect}
          />
        </>
      ) : (
        <>
          {/* Title and metadata */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className={cn('font-medium text-sm truncate', 'text-foreground/90')}>
                {displayTitle}
              </span>
              {/* Snooze badge with warm styling */}
              {item.snoozedUntil && (
                <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                  <Clock className="w-2.5 h-2.5" aria-hidden="true" />
                  {formatSnoozeReturn(
                    item.snoozedUntil instanceof Date
                      ? item.snoozedUntil
                      : new Date(item.snoozedUntil)
                  )}
                </span>
              )}
            </div>
            <TranscriptionStatus item={item} onRetry={onRetryTranscription} />
          </div>

          {/* Timestamp - fades out on hover when actions show */}
          <span
            className={cn(
              'shrink-0 text-xs text-muted-foreground/60 tabular-nums',
              'transition-opacity duration-150',
              isInBulkMode ? 'opacity-100' : 'group-hover:opacity-0'
            )}
          >
            {formatTimestamp(
              item.createdAt instanceof Date ? item.createdAt : new Date(item.createdAt),
              period
            )}
          </span>

          {/* Quick Actions - slide in from right on hover (hidden in bulk mode) */}
          {!isInBulkMode && (
            <div className="shrink-0 quick-actions-reveal">
              <QuickActions
                itemId={item.id}
                onFile={onFile}
                onPreview={onPreview}
                onDelete={onDelete}
                onSnooze={onSnooze}
                variant="row"
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ============================================================================
// Export everything
// ============================================================================

export { TypeIcon, TranscriptionStatus, ItemThumbnail }
