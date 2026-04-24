/**
 * InboxList Components
 *
 * Reusable list components for inbox items with multi-selection support,
 * collapsible time-based sections, and editorial styling.
 * Matches the design pattern from template-selector.
 */

import { useState, createContext, useContext } from 'react'
import {
  ChevronRight,
  Link2,
  FileText,
  Image,
  Mic,
  Scissors,
  FilePdf,
  Share2,
  Loader2,
  AlertCircle,
  RotateCcw,
  Bell,
  Video
} from '@/lib/icons'
import type { ReminderMetadata } from '@memry/contracts/inbox-api'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/ui/pill'
import { QuickActions } from '@/components/quick-actions'
import { InlineQuickFile } from '@/components/inline-quick-file'
import { QuickFileDropdown, getFilteredFolders } from '@/components/quick-file-dropdown'
import {
  formatDuration,
  formatCompactRelativeTime,
  extractDomain,
  type TimePeriod
} from '@/lib/inbox-utils'
import { cn } from '@/lib/utils'
import {
  type DisplayDensity,
  DENSITY_CONFIG,
  type DensityConfig
} from '@/hooks/use-display-density'
import type { InboxItemListItem, InboxItemType, Folder } from '@/types'

type InboxItem = InboxItemListItem

// ============================================================================
// Context for selection and focus state
// ============================================================================

interface InboxListContextValue {
  selectedIds: Set<string>
  focusedId: string | null
  isInBulkMode: boolean
  densityConfig: DensityConfig
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
// Type Icon Colors — distinct color per capture type
// ============================================================================

const TYPE_ICON_COLORS: Record<string, string> = {
  link: 'text-indigo-500 dark:text-indigo-400',
  voice: 'text-amber-500 dark:text-amber-400',
  image: 'text-emerald-500 dark:text-emerald-400',
  clip: 'text-purple-400 dark:text-purple-300',
  note: 'text-muted-foreground/60',
  pdf: 'text-red-500 dark:text-red-400',
  social: 'text-sky-400 dark:text-sky-300',
  video: 'text-sky-500 dark:text-sky-400',
  reminder: 'text-amber-500 dark:text-amber-400'
}

// ============================================================================
// Type Icon - colored per capture type with transcription awareness
// ============================================================================

interface TypeIconProps {
  type: InboxItemType
  transcriptionStatus?: string | null
}

const TypeIcon = ({ type, transcriptionStatus }: TypeIconProps): React.JSX.Element => {
  const iconSize = 'w-3.5 h-3.5'

  if (type === 'voice') {
    if (transcriptionStatus === 'pending' || transcriptionStatus === 'processing') {
      return (
        <Loader2
          className={cn(iconSize, 'text-amber-500 dark:text-amber-400 animate-spin')}
          aria-hidden="true"
        />
      )
    }
    if (transcriptionStatus === 'failed') {
      return (
        <AlertCircle
          className={cn(iconSize, 'text-red-500 dark:text-red-400')}
          aria-hidden="true"
        />
      )
    }
    return <Mic className={cn(iconSize, TYPE_ICON_COLORS.voice)} aria-hidden="true" />
  }

  if (type === 'reminder') {
    return <Bell className={cn(iconSize, TYPE_ICON_COLORS.reminder)} aria-hidden="true" />
  }

  const color = TYPE_ICON_COLORS[type] || TYPE_ICON_COLORS.note

  switch (type) {
    case 'link':
      return <Link2 className={cn(iconSize, color)} aria-hidden="true" />
    case 'note':
      return <FileText className={cn(iconSize, color)} aria-hidden="true" />
    case 'image':
      return <Image className={cn(iconSize, color)} aria-hidden="true" />
    case 'clip':
      return <Scissors className={cn(iconSize, color)} aria-hidden="true" />
    case 'pdf':
      return <FilePdf className={cn(iconSize, color)} aria-hidden="true" />
    case 'social':
      return <Share2 className={cn(iconSize, color)} aria-hidden="true" />
    case 'video':
      return <Video className={cn(iconSize, color)} aria-hidden="true" />
    default:
      return <FileText className={cn(iconSize, TYPE_ICON_COLORS.note)} aria-hidden="true" />
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

const ThumbnailImage = ({ thumbnailUrl }: { thumbnailUrl: string }): React.JSX.Element | null => {
  const [imageError, setImageError] = useState(false)

  if (imageError) return null

  return (
    <div className="w-9 h-9 rounded-md overflow-hidden bg-muted shrink-0 ring-1 ring-border/50">
      <img
        src={thumbnailUrl}
        alt=""
        className="w-full h-full object-cover"
        onError={() => setImageError(true)}
        loading="lazy"
      />
    </div>
  )
}

const ItemThumbnail = ({ item }: { item: InboxItem }): React.JSX.Element | null => {
  if (item.type !== 'image' || !item.thumbnailUrl) {
    return null
  }

  return <ThumbnailImage key={item.thumbnailUrl} thumbnailUrl={item.thumbnailUrl} />
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
  /** Display density preference */
  density?: DisplayDensity
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
  density = 'comfortable',
  onSelect,
  onFocus,
  children,
  className
}: InboxListSectionProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed)
  const isInBulkMode = selectedIds.size > 0
  const densityConfig = DENSITY_CONFIG[density]

  const formattedTitle = title.charAt(0).toUpperCase() + title.slice(1).toLowerCase()

  return (
    <InboxListContext.Provider
      value={{ selectedIds, focusedId, isInBulkMode, densityConfig, onSelect, onFocus }}
    >
      <section
        className={className}
        aria-labelledby={`section-${title.toLowerCase().replace(/\s/g, '-')}`}
      >
        <button
          type="button"
          onClick={() => collapsible && setIsCollapsed(!isCollapsed)}
          className={cn(
            'flex items-center gap-1.5 w-full text-left py-2 px-2',
            collapsible && 'cursor-pointer group'
          )}
          disabled={!collapsible}
          id={`section-${title.toLowerCase().replace(/\s/g, '-')}`}
        >
          {collapsible && (
            <ChevronRight
              className={cn(
                'w-2.5 h-2.5 text-muted-foreground/40 transition-transform duration-200',
                !isCollapsed && 'rotate-90'
              )}
            />
          )}
          {icon && <span>{icon}</span>}
          <span
            className={cn(
              'text-xs font-semibold tracking-[0.02em] text-muted-foreground',
              'transition-colors'
            )}
          >
            {formattedTitle}
          </span>
          {count !== undefined && (
            <span className="text-[11px] leading-[14px] text-muted-foreground/50 tabular-nums">
              {count}
            </span>
          )}
        </button>

        {!isCollapsed && <div className="space-y-px">{children}</div>}
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
  onPreview: (id: string) => void
  onArchive: (id: string) => void
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
  onPreview,
  onArchive,
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
  const { selectedIds, focusedId, isInBulkMode, densityConfig, onSelect, onFocus } = useInboxList()
  const isSelected = selectedIds.has(item.id)
  const isFocused = focusedId === item.id

  const filteredFolders = getFilteredFolders(folders, quickFileQuery, 5)

  // For reminder items, show the target title from metadata
  const reminderMetadata = item.type === 'reminder' ? (item.metadata as ReminderMetadata) : null
  const isReminderViewed = item.type === 'reminder' && !!item.viewedAt

  const displayTitle =
    item.type === 'reminder' && reminderMetadata?.targetTitle
      ? reminderMetadata.targetTitle
      : item.title

  const handleClick = (): void => {
    onFocus(item.id)
    onPreview(item.id)
  }

  const handleCheckboxClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onSelect(item.id, e.shiftKey)
  }

  return (
    <div
      className={cn(
        'group relative w-full',
        'flex items-center',
        'gap-2.5',
        densityConfig.itemPadding,
        densityConfig.itemRadius,
        'transition-all duration-150 ease-out',
        'cursor-pointer',
        isExiting && 'item-removing',
        'hover:bg-muted/50',
        isSelected && [
          'bg-[var(--user-accent-color)]/[0.04]',
          'hover:bg-[var(--user-accent-color)]/[0.06]',
          'ring-1 ring-inset ring-[var(--user-accent-color)]/25'
        ],
        !isSelected &&
          isFocused && ['bg-muted', 'ring-1 ring-inset ring-[var(--user-accent-color)]/40'],
        item.isStale && 'opacity-60',
        className
      )}
      role="listitem"
      tabIndex={isFocused ? 0 : -1}
      aria-label={`${item.type}: ${displayTitle}`}
      aria-selected={isSelected}
      onClick={handleClick}
      data-item-id={item.id}
    >
      {/* Checkbox */}
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
            'transition-colors',
            densityConfig.checkboxSize
          )}
          aria-label={`Select ${displayTitle}`}
          onClick={handleCheckboxClick}
        />
      </div>

      {/* Type icon — bare, colored per type */}
      <div className="flex-shrink-0">
        <TypeIcon type={item.type} transcriptionStatus={item.transcriptionStatus} />
      </div>

      {isQuickFileActive && onQuickFileFolderSelect ? (
        <>
          <span
            className={cn(
              densityConfig.titleSize,
              'text-foreground/90 truncate max-w-[40%] shrink-0 font-medium'
            )}
          >
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
          {/* Title — single line, truncated */}
          <span
            className={cn(
              'grow shrink min-w-0 truncate font-medium',
              densityConfig.titleSize,
              isReminderViewed
                ? 'text-muted-foreground/60'
                : item.snoozedUntil
                  ? 'text-muted-foreground'
                  : 'text-foreground/90'
            )}
          >
            {displayTitle}
          </span>

          {/* Voice duration pill — hidden on hover when actions show */}
          {item.type === 'voice' && item.duration != null && (
            <div className={cn('shrink-0', !isInBulkMode && 'group-hover:opacity-0')}>
              <Pill variant="bordered" color="amber">
                {formatDuration(item.duration)}
              </Pill>
            </div>
          )}

          {/* PDF page count pill */}
          {item.type === 'pdf' && item.pageCount != null && (
            <Pill variant="bordered" color="red">
              {item.pageCount} page{item.pageCount !== 1 ? 's' : ''}
            </Pill>
          )}

          {/* Snooze pill */}
          {item.snoozedUntil && (
            <Pill variant="filled" color="gray">
              snoozed til{' '}
              {new Date(item.snoozedUntil).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric'
              })}
            </Pill>
          )}

          {/* Right slot: metadata swaps to actions on hover */}
          <div className="relative shrink-0 flex items-center">
            {/* Metadata — visible by default, hidden on hover */}
            <div
              className={cn('flex items-center gap-2', !isInBulkMode && 'group-hover:opacity-0')}
            >
              {item.sourceUrl &&
                (item.type === 'link' || item.type === 'social' || item.type === 'clip') && (
                  <span
                    className={cn('shrink-0', densityConfig.metaSize, 'text-muted-foreground/60')}
                  >
                    {extractDomain(item.sourceUrl)}
                  </span>
                )}
              <span
                className={cn(
                  'shrink-0 w-9 text-right tabular-nums',
                  densityConfig.metaSize,
                  item.isStale ? 'text-amber-600 dark:text-amber-500' : 'text-muted-foreground/60'
                )}
              >
                {formatCompactRelativeTime(
                  item.createdAt instanceof Date ? item.createdAt : new Date(item.createdAt)
                )}
              </span>
            </div>

            {/* Actions — overlaid, visible on hover */}
            {!isInBulkMode && (
              <div
                className={cn(
                  'absolute inset-0 flex items-center justify-end',
                  'opacity-0 group-hover:opacity-100'
                )}
              >
                <QuickActions
                  itemId={item.id}
                  onArchive={onArchive}
                  onSnooze={onSnooze}
                  variant="row"
                />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ============================================================================
// Export everything
// ============================================================================

export { TypeIcon, TranscriptionStatus, ItemThumbnail }
