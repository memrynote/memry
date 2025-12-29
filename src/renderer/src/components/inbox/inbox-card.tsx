/**
 * InboxCard Components
 *
 * Card-based display for inbox items with multi-selection support,
 * editorial styling with warm amber accents, and smooth animations.
 * Matches the design pattern from template-selector.
 */

import { useState, useEffect, useRef, createContext, useContext } from 'react'
import {
  Link,
  FileText,
  Image,
  Mic,
  Play,
  Globe,
  Scissors,
  FileIcon,
  Share2,
  Clock
} from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { QuickActions } from '@/components/quick-actions'
import { SocialCardContent } from '@/components/social-card'
import { formatSnoozeReturn } from '@/components/snooze'
import { formatTimestamp, formatDuration, extractDomain, type TimePeriod } from '@/lib/inbox-utils'
import { cn } from '@/lib/utils'
import type { InboxItemListItem, InboxItemType } from '@/types'

type InboxItem = InboxItemListItem

// ============================================================================
// Context for selection and focus state
// ============================================================================

interface InboxCardContextValue {
  selectedIds: Set<string>
  focusedId: string | null
  isInBulkMode: boolean
  onSelect: (id: string, shiftKey: boolean) => void
  onFocus: (id: string) => void
}

const InboxCardContext = createContext<InboxCardContextValue | null>(null)

function useInboxCardContext() {
  const context = useContext(InboxCardContext)
  if (!context) {
    throw new Error('InboxCard must be used within an InboxCardSection')
  }
  return context
}

// ============================================================================
// Type Icon - matches the inbox item type
// ============================================================================

const TypeIcon = ({
  type,
  className
}: {
  type: InboxItemType
  className?: string
}): React.JSX.Element => {
  const iconClass = className || 'w-4 h-4 text-muted-foreground/60'

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
// Card Content Components
// ============================================================================

const LinkCardContent = ({ item }: { item: InboxItem }): React.JSX.Element => {
  const domain = item.sourceUrl ? extractDomain(item.sourceUrl) : 'unknown'

  return (
    <div className="flex flex-col items-center justify-center h-full gap-2">
      <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-900/30 dark:to-orange-900/20 flex items-center justify-center border border-amber-200/30 dark:border-amber-800/30">
        <Globe className="w-6 h-6 text-amber-600 dark:text-amber-500" aria-hidden="true" />
      </div>
      <span className="text-xs text-muted-foreground/70 truncate max-w-full px-2 font-medium">
        {domain}
      </span>
    </div>
  )
}

const NoteCardContent = ({ item }: { item: InboxItem }): React.JSX.Element => {
  const previewText = item.content || item.title

  return (
    <div className="h-full px-1 overflow-hidden">
      <p className="text-xs text-muted-foreground/70 leading-relaxed line-clamp-4">{previewText}</p>
    </div>
  )
}

const ImageCardContent = ({ item }: { item: InboxItem }): React.JSX.Element => {
  const [imageError, setImageError] = useState(false)

  useEffect(() => {
    setImageError(false)
  }, [item.thumbnailUrl])

  if (item.thumbnailUrl && !imageError) {
    return (
      <div className="h-full rounded-lg overflow-hidden ring-1 ring-border/30">
        <img
          src={item.thumbnailUrl}
          alt={item.title}
          className="w-full h-full object-cover"
          onError={() => setImageError(true)}
          loading="lazy"
        />
      </div>
    )
  }

  return (
    <div className="h-full bg-gradient-to-br from-muted to-muted/50 rounded-lg flex items-center justify-center">
      <Image className="w-8 h-8 text-muted-foreground/30" aria-hidden="true" />
    </div>
  )
}

const VoiceCardContent = ({ item }: { item: InboxItem }): React.JSX.Element => {
  const duration = item.duration ? formatDuration(item.duration) : '0:00'

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={cn(
            'w-10 h-10 rounded-full flex items-center justify-center',
            'bg-gradient-to-r from-amber-600 to-orange-600',
            'text-white shadow-md shadow-amber-600/20',
            'hover:from-amber-500 hover:to-orange-500',
            'hover:shadow-lg hover:shadow-amber-600/30',
            'transition-all duration-200'
          )}
          aria-label="Play voice memo"
          onClick={(e) => e.stopPropagation()}
        >
          <Play className="w-4 h-4 ml-0.5" aria-hidden="true" />
        </button>
        <div className="flex items-center gap-0.5 h-6">
          {[0.4, 0.7, 0.5, 0.9, 0.6, 0.8, 0.4, 0.6, 0.7, 0.5, 0.3].map((height, i) => (
            <div
              key={i}
              className="w-1 rounded-full bg-amber-400/40 dark:bg-amber-600/40"
              style={{ height: `${height * 100}%` }}
              aria-hidden="true"
            />
          ))}
        </div>
      </div>
      <span className="text-sm font-semibold text-foreground/90 tabular-nums">{duration}</span>
    </div>
  )
}

const SocialCardContentWrapper = ({ item }: { item: InboxItem }): React.JSX.Element => {
  return (
    <SocialCardContent
      title={item.title}
      content={item.content}
      sourceUrl={item.sourceUrl}
      processingStatus={item.processingStatus}
      variant="card"
    />
  )
}

const CardContent = ({ item }: { item: InboxItem }): React.JSX.Element => {
  switch (item.type) {
    case 'link':
      return <LinkCardContent item={item} />
    case 'note':
      return <NoteCardContent item={item} />
    case 'image':
      return <ImageCardContent item={item} />
    case 'voice':
      return <VoiceCardContent item={item} />
    case 'social':
      return <SocialCardContentWrapper item={item} />
    case 'clip':
    case 'pdf':
    default:
      return <NoteCardContent item={item} />
  }
}

// ============================================================================
// InboxCardSection - Section wrapper with header (like SelectableListSection)
// ============================================================================

export interface InboxCardSectionProps {
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
  /** Section content (InboxCard components) */
  children: React.ReactNode
  /** Additional class names */
  className?: string
}

export function InboxCardSection({
  title,
  icon,
  count,
  selectedIds,
  focusedId,
  onSelect,
  onFocus,
  children,
  className
}: InboxCardSectionProps) {
  const isInBulkMode = selectedIds.size > 0

  return (
    <InboxCardContext.Provider value={{ selectedIds, focusedId, isInBulkMode, onSelect, onFocus }}>
      <section
        className={className}
        aria-labelledby={`card-section-${title.toLowerCase().replace(/\s/g, '-')}`}
      >
        {/* Section header with warm accent */}
        <div
          className="flex items-center gap-2 mb-4"
          id={`card-section-${title.toLowerCase().replace(/\s/g, '-')}`}
        >
          {icon && <span className="text-amber-600 dark:text-amber-500">{icon}</span>}
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
            {title}
          </h3>
          {count !== undefined && (
            <span className="text-xs text-muted-foreground/40 tabular-nums">{count}</span>
          )}
          <div className="flex-1 h-px bg-gradient-to-r from-amber-200/30 dark:from-amber-800/30 to-transparent" />
        </div>

        {/* Grid of cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">{children}</div>
      </section>
    </InboxCardContext.Provider>
  )
}

// ============================================================================
// InboxCard - Individual card component
// ============================================================================

export interface InboxCardProps {
  /** The inbox item */
  item: InboxItem
  /** Time period for timestamp formatting */
  period: TimePeriod
  /** Whether the item is exiting (animating out) */
  isExiting?: boolean
  /** Callbacks */
  onFile: (id: string) => void
  onPreview: (id: string) => void
  onDelete: (id: string) => void
  onSnooze?: (id: string, snoozeUntil: string) => void
  /** Additional class names */
  className?: string
}

export function InboxCard({
  item,
  period,
  isExiting = false,
  onFile,
  onPreview,
  onDelete,
  onSnooze,
  className
}: InboxCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const { selectedIds, focusedId, isInBulkMode, onSelect, onFocus } = useInboxCardContext()
  const isSelected = selectedIds.has(item.id)
  const isFocused = focusedId === item.id

  // Scroll into view when focused
  useEffect(() => {
    if (isFocused && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [isFocused])

  const handleClick = (): void => {
    onFocus(item.id)
  }

  const handleCheckboxClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onSelect(item.id, e.shiftKey)
  }

  return (
    <div
      ref={cardRef}
      className={cn(
        'group relative flex flex-col rounded-xl border bg-card overflow-hidden cursor-pointer',
        'transition-all duration-200 ease-out',
        // Exit animation
        isExiting && 'card-removing',
        // Selection state - warm amber glow
        !isExiting && isSelected && [
          'border-amber-300 dark:border-amber-700',
          'ring-2 ring-amber-200/50 dark:ring-amber-800/50',
          'shadow-lg shadow-amber-500/10',
          '-translate-y-0.5'
        ],
        // Focused state (not selected)
        !isExiting && !isSelected && isFocused && [
          'border-amber-400/50 dark:border-amber-600/50',
          'ring-2 ring-amber-300/30 dark:ring-amber-700/30',
          'shadow-lg'
        ],
        // Default hover state
        !isExiting &&
          !isSelected &&
          !isFocused && [
            'border-border/60',
            'shadow-sm',
            'hover:shadow-md hover:border-amber-200/50 dark:hover:border-amber-800/50',
            'hover:-translate-y-1'
          ],
        className
      )}
      role="article"
      tabIndex={isFocused ? 0 : -1}
      aria-label={`${item.type}: ${item.title}`}
      aria-selected={isSelected}
      onClick={handleClick}
      data-item-id={item.id}
    >
      {/* Checkbox - always visible in bulk mode, otherwise on hover/focus */}
      <div
        className={cn(
          'absolute top-2.5 left-2.5 z-10 transition-opacity duration-150',
          isSelected || isInBulkMode || isFocused
            ? 'opacity-100'
            : 'opacity-0 group-hover:opacity-100'
        )}
      >
        <Checkbox
          id={`inbox-card-${item.id}`}
          checked={isSelected}
          onCheckedChange={() => {}}
          className={cn(
            'bg-background/90 shadow-sm',
            'border-muted-foreground/30',
            'data-[state=checked]:bg-amber-600 data-[state=checked]:border-amber-600',
            'dark:data-[state=checked]:bg-amber-500 dark:data-[state=checked]:border-amber-500'
          )}
          aria-label={`Select ${item.title}`}
          onClick={handleCheckboxClick}
        />
      </div>

      {/* Top Bar: Icon + Timestamp + Snooze Badge */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/40 bg-muted/20">
        <div
          className={cn(
            'w-7 h-7 rounded-lg flex items-center justify-center',
            'bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-900/30 dark:to-orange-900/20',
            'border border-amber-200/30 dark:border-amber-800/30'
          )}
        >
          <TypeIcon type={item.type} className="w-3.5 h-3.5 text-amber-600 dark:text-amber-500" />
        </div>
        <div className="flex items-center gap-2">
          {item.snoozedUntil && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
              <Clock className="w-2.5 h-2.5" aria-hidden="true" />
              {formatSnoozeReturn(
                item.snoozedUntil instanceof Date ? item.snoozedUntil : new Date(item.snoozedUntil)
              )}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground/60 tabular-nums">
            {formatTimestamp(item.createdAt, period)}
          </span>
        </div>
      </div>

      {/* Content Area */}
      <div className="h-[120px] p-3">
        <CardContent item={item} />
      </div>

      {/* Bottom: Title - hidden on hover when actions show (unless in bulk mode) */}
      <div
        className={cn(
          'px-3 py-2.5 border-t border-border/40 bg-muted/10',
          'transition-opacity duration-150',
          isInBulkMode ? '' : isFocused ? 'hidden' : 'group-hover:hidden'
        )}
      >
        <p className="text-sm font-medium text-foreground/90 line-clamp-2 leading-snug">
          {item.title}
        </p>
      </div>

      {/* Quick Actions overlay - visible on hover or focus (hidden in bulk mode) */}
      {!isInBulkMode && (
        <div
          className={cn(
            'px-3 py-2.5 border-t border-amber-200/30 dark:border-amber-800/30',
            'bg-gradient-to-r from-amber-50/50 to-orange-50/50 dark:from-amber-950/30 dark:to-orange-950/30',
            'items-center justify-center',
            'transition-opacity duration-150',
            isFocused
              ? 'flex opacity-100'
              : 'hidden group-hover:flex opacity-0 group-hover:opacity-100'
          )}
        >
          <QuickActions
            itemId={item.id}
            onFile={onFile}
            onPreview={onPreview}
            onDelete={onDelete}
            onSnooze={onSnooze}
            variant="card"
          />
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Export everything
// ============================================================================

export { TypeIcon, CardContent }
