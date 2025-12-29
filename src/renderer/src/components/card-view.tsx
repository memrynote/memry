import { useState, useEffect, useCallback, useRef } from 'react'
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
import { StaleSection } from '@/components/stale/stale-section'
import { formatSnoozeReturn } from '@/components/snooze'
import {
  groupItemsByTimePeriod,
  formatTimestamp,
  formatDuration,
  extractDomain,
  type TimePeriod
} from '@/lib/inbox-utils'
import { cn } from '@/lib/utils'
import type { InboxItemListItem, InboxItemType } from '@/types'

// Use InboxItemListItem for card views
type InboxItem = InboxItemListItem

// Icon component based on item type
const TypeIcon = ({
  type,
  className
}: {
  type: InboxItemType
  className?: string
}): React.JSX.Element => {
  const iconClass = className || 'size-4 text-[var(--muted-foreground)]'

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
  }
}

// Link card content - shows domain and favicon placeholder
const LinkCardContent = ({ item }: { item: InboxItem }): React.JSX.Element => {
  const domain = item.sourceUrl ? extractDomain(item.sourceUrl) : 'unknown'

  return (
    <div className="flex flex-col items-center justify-center h-full gap-2">
      <div className="size-10 rounded-lg bg-[var(--muted)] flex items-center justify-center">
        <Globe className="size-5 text-[var(--muted-foreground)]" aria-hidden="true" />
      </div>
      <span className="text-xs text-[var(--muted-foreground)] truncate max-w-full px-2">
        {domain}
      </span>
    </div>
  )
}

// Note card content - shows preview text
const NoteCardContent = ({ item }: { item: InboxItem }): React.JSX.Element => {
  const previewText = item.content || item.title

  return (
    <div className="h-full px-1 overflow-hidden">
      <p className="text-xs text-[var(--muted-foreground)] leading-relaxed line-clamp-4">
        {previewText}
      </p>
    </div>
  )
}

// Image card content - shows thumbnail or placeholder
const ImageCardContent = ({ item }: { item: InboxItem }): React.JSX.Element => {
  const [imageError, setImageError] = useState(false)

  // Reset error state if thumbnail URL changes
  useEffect(() => {
    setImageError(false)
  }, [item.thumbnailUrl])

  // Show actual thumbnail if available
  if (item.thumbnailUrl && !imageError) {
    return (
      <div className="h-full rounded-md overflow-hidden">
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

  // Fallback to placeholder icon
  return (
    <div className="h-full bg-[var(--muted)] rounded-md flex items-center justify-center">
      <Image className="size-8 text-[var(--muted-foreground)]/50" aria-hidden="true" />
    </div>
  )
}

// Voice card content - waveform and duration
const VoiceCardContent = ({ item }: { item: InboxItem }): React.JSX.Element => {
  const duration = item.duration ? formatDuration(item.duration) : '0:00'

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3">
      {/* Play button and waveform visualization */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="size-8 rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] flex items-center justify-center hover:opacity-90 transition-opacity"
          aria-label="Play voice memo"
          onClick={(e) => e.stopPropagation()}
        >
          <Play className="size-4 ml-0.5" aria-hidden="true" />
        </button>
        {/* Simplified waveform bars */}
        <div className="flex items-center gap-0.5 h-6">
          {[0.4, 0.7, 0.5, 0.9, 0.6, 0.8, 0.4, 0.6, 0.7, 0.5, 0.3].map((height, i) => (
            <div
              key={i}
              className="w-1 rounded-full bg-[var(--muted-foreground)]/40"
              style={{ height: `${height * 100}%` }}
              aria-hidden="true"
            />
          ))}
        </div>
      </div>
      {/* Duration */}
      <span className="text-sm font-medium text-[var(--foreground)] tabular-nums">{duration}</span>
    </div>
  )
}

// Social card content - uses dedicated social card component
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

// Card content renderer based on item type
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

// Individual card component
interface InboxCardProps {
  item: InboxItem
  period: TimePeriod
  isFocused: boolean
  isSelected: boolean
  isInBulkMode: boolean
  isExiting?: boolean
  onFile: (id: string) => void
  onPreview: (id: string) => void
  onDelete: (id: string) => void
  onSnooze?: (id: string, snoozeUntil: string) => void
  onFocus: (id: string) => void
  onSelectionToggle: (id: string, shiftKey: boolean) => void
}

const InboxCard = ({
  item,
  period,
  isFocused,
  isSelected,
  isInBulkMode,
  isExiting = false,
  onFile,
  onPreview,
  onDelete,
  onSnooze,
  onFocus,
  onSelectionToggle
}: InboxCardProps): React.JSX.Element => {
  const cardRef = useRef<HTMLDivElement>(null)

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
    onSelectionToggle(item.id, e.shiftKey)
  }

  const handleCheckboxChange = (_checked: boolean | 'indeterminate'): void => {
    // This is called when clicking the checkbox directly
    // The actual toggle is handled in handleCheckboxClick for shift-key support
  }

  return (
    <div
      ref={cardRef}
      className={cn(
        'group relative flex flex-col rounded-lg border bg-card shadow-sm cursor-pointer overflow-hidden',
        // Smooth transitions using animation tokens with hover lift
        'transition-[transform,box-shadow,border-color,opacity] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
        // Exit animation using CSS class
        isExiting && 'card-removing',
        // Selection/focus states (only apply when not exiting)
        !isExiting && isSelected
          ? 'border-primary ring-2 ring-primary/30 shadow-lg -translate-y-0.5'
          : !isExiting && isFocused
            ? 'border-ring ring-2 ring-ring ring-offset-1 ring-offset-background shadow-lg'
            : 'border-border hover:shadow-[var(--shadow-card-hover)] hover:border-border/80 hover:-translate-y-1'
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
          'absolute top-2 left-2 z-10 transition-opacity duration-[var(--duration-instant)] ease-[var(--ease-out)]',
          isSelected || isInBulkMode
            ? 'opacity-100'
            : isFocused
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100'
        )}
      >
        <Checkbox
          id={`card-${item.id}`}
          checked={isSelected}
          onCheckedChange={handleCheckboxChange}
          className="bg-[var(--background)] shadow-sm"
          aria-label={`Select ${item.title}`}
          onClick={handleCheckboxClick}
        />
      </div>

      {/* Top Bar: Icon + Timestamp + Snooze Badge */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]/50 bg-[var(--muted)]/30">
        <TypeIcon type={item.type} />
        <div className="flex items-center gap-2">
          {/* Snooze badge - shown when item is snoozed */}
          {item.snoozedUntil && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
              <Clock className="size-2.5" aria-hidden="true" />
              {formatSnoozeReturn(
                item.snoozedUntil instanceof Date ? item.snoozedUntil : new Date(item.snoozedUntil)
              )}
            </span>
          )}
          <span className="text-[10px] text-[var(--muted-foreground)] tabular-nums">
            {formatTimestamp(item.createdAt, period)}
          </span>
        </div>
      </div>

      {/* Content Area - fixed height */}
      <div className="h-[120px] p-3">
        <CardContent item={item} />
      </div>

      {/* Bottom: Title - hidden on hover when actions show (unless in bulk mode) */}
      <div
        className={cn(
          'px-3 py-2 border-t border-[var(--border)]/50 bg-[var(--muted)]/20 transition-opacity duration-100',
          isInBulkMode ? '' : isFocused ? 'hidden' : 'group-hover:hidden'
        )}
      >
        <p className="text-sm font-medium text-[var(--foreground)] line-clamp-2 leading-snug">
          {item.title}
        </p>
      </div>

      {/* Quick Actions overlay - visible on hover or focus (hidden in bulk mode) */}
      {!isInBulkMode && (
        <div
          className={cn(
            'px-3 py-2 border-t border-border/50 bg-muted/40 items-center justify-center',
            'transition-opacity duration-[var(--duration-instant)] ease-[var(--ease-out)]',
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

// Section header component
const SectionHeader = ({ period }: { period: TimePeriod }): React.JSX.Element => {
  return (
    <h3 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]/70 mb-3">
      {period}
    </h3>
  )
}

// Main CardView component
interface CardViewProps {
  items: InboxItem[]
  staleItems?: InboxItem[]
  selectedItemIds: Set<string>
  exitingItemIds?: Set<string>
  onFile: (id: string) => void
  onPreview: (id: string) => void
  onDelete: (id: string) => void
  onSnooze?: (id: string, snoozeUntil: string) => void
  onSelectionChange: (selectedIds: Set<string>) => void
  onFileAllStale?: () => void
  onReviewStale?: () => void
  focusedItemId?: string | null
  onFocusedItemChange?: (id: string | null) => void
  isPreviewOpen?: boolean
}

const CardView = ({
  items,
  staleItems = [],
  selectedItemIds,
  exitingItemIds = new Set(),
  onFile,
  onPreview,
  onDelete,
  onSnooze,
  onSelectionChange,
  onFileAllStale,
  onReviewStale,
  focusedItemId: controlledFocusedItemId,
  onFocusedItemChange,
  isPreviewOpen: _isPreviewOpen = false
}: CardViewProps): React.JSX.Element => {
  void _isPreviewOpen // Reserved for future use
  const containerRef = useRef<HTMLDivElement>(null)
  const groupedItems = groupItemsByTimePeriod(items)

  // Flatten all items (stale + regular) for keyboard navigation
  const flatItems = [...staleItems, ...groupedItems.flatMap((group) => group.items)]

  // Track last selected item for shift-click range selection
  const lastSelectedIdRef = useRef<string | null>(null)

  // State - use controlled focus if provided, otherwise internal state
  const [internalFocusedItemId, setInternalFocusedItemId] = useState<string | null>(
    flatItems[0]?.id || null
  )
  const focusedItemId =
    controlledFocusedItemId !== undefined ? controlledFocusedItemId : internalFocusedItemId

  const setFocusedItemId = useCallback(
    (id: string | null): void => {
      if (controlledFocusedItemId === undefined) {
        setInternalFocusedItemId(id)
      }
      onFocusedItemChange?.(id)
    },
    [controlledFocusedItemId, onFocusedItemChange]
  )

  const isInBulkMode = selectedItemIds.size > 0

  // Reset focus when items change
  useEffect(() => {
    if (flatItems.length > 0 && !flatItems.find((i) => i.id === focusedItemId)) {
      const newFocusId = flatItems[0]?.id || null
      setFocusedItemId(newFocusId)
    }
  }, [flatItems, focusedItemId, setFocusedItemId])

  // Grid navigation - assume 3 columns on large screens, 2 on medium, 1 on small
  const getColumnsCount = (): number => {
    if (typeof window !== 'undefined') {
      if (window.innerWidth >= 1024) return 3
      if (window.innerWidth >= 640) return 2
      return 1
    }
    return 3
  }

  // Handle selection toggle with shift-click support
  const handleSelectionToggle = useCallback(
    (id: string, shiftKey: boolean): void => {
      const newSelection = new Set(selectedItemIds)

      if (shiftKey && lastSelectedIdRef.current) {
        // Range selection
        const lastIndex = flatItems.findIndex((i) => i.id === lastSelectedIdRef.current)
        const currentIndex = flatItems.findIndex((i) => i.id === id)

        if (lastIndex !== -1 && currentIndex !== -1) {
          const start = Math.min(lastIndex, currentIndex)
          const end = Math.max(lastIndex, currentIndex)

          for (let i = start; i <= end; i++) {
            newSelection.add(flatItems[i].id)
          }
        }
      } else {
        // Toggle single item
        if (newSelection.has(id)) {
          newSelection.delete(id)
        } else {
          newSelection.add(id)
        }
      }

      lastSelectedIdRef.current = id
      onSelectionChange(newSelection)
    },
    [selectedItemIds, flatItems, onSelectionChange]
  )

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      // Ignore if typing in input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }

      const currentIndex = flatItems.findIndex((i) => i.id === focusedItemId)
      const columns = getColumnsCount()

      switch (e.key) {
        case ' ': // Space key toggles preview
          e.preventDefault()
          if (focusedItemId) {
            onPreview(focusedItemId)
          }
          break

        case 'x':
        case 'X':
          // Toggle selection on focused item
          if (focusedItemId) {
            e.preventDefault()
            handleSelectionToggle(focusedItemId, e.shiftKey)
          }
          break

        case 'ArrowDown':
        case 'j':
          e.preventDefault()
          // Move down by one row (columns count)
          if (currentIndex + columns < flatItems.length) {
            const nextId = flatItems[currentIndex + columns].id
            setFocusedItemId(nextId)
            if (e.shiftKey && isInBulkMode) {
              handleSelectionToggle(nextId, false)
            }
          } else if (currentIndex < flatItems.length - 1) {
            const nextId = flatItems[flatItems.length - 1].id
            setFocusedItemId(nextId)
            if (e.shiftKey && isInBulkMode) {
              handleSelectionToggle(nextId, false)
            }
          }
          break

        case 'ArrowUp':
        case 'k':
          e.preventDefault()
          // Move up by one row (columns count)
          if (currentIndex - columns >= 0) {
            const prevId = flatItems[currentIndex - columns].id
            setFocusedItemId(prevId)
            if (e.shiftKey && isInBulkMode) {
              handleSelectionToggle(prevId, false)
            }
          } else if (currentIndex > 0) {
            const prevId = flatItems[0].id
            setFocusedItemId(prevId)
            if (e.shiftKey && isInBulkMode) {
              handleSelectionToggle(prevId, false)
            }
          }
          break

        case 'ArrowRight':
        case 'l':
          e.preventDefault()
          // Move to next item
          if (currentIndex < flatItems.length - 1) {
            const nextId = flatItems[currentIndex + 1].id
            setFocusedItemId(nextId)
            if (e.shiftKey && isInBulkMode) {
              handleSelectionToggle(nextId, false)
            }
          }
          break

        case 'ArrowLeft':
        case 'h':
          e.preventDefault()
          // Move to previous item
          if (currentIndex > 0) {
            const prevId = flatItems[currentIndex - 1].id
            setFocusedItemId(prevId)
            if (e.shiftKey && isInBulkMode) {
              handleSelectionToggle(prevId, false)
            }
          }
          break

        case 'Home':
          // Jump to first item
          e.preventDefault()
          if (flatItems.length > 0) {
            setFocusedItemId(flatItems[0].id)
          }
          break

        case 'End':
          // Jump to last item
          e.preventDefault()
          if (flatItems.length > 0) {
            setFocusedItemId(flatItems[flatItems.length - 1].id)
          }
          break

        case 'PageDown':
          // Jump 10 items down
          e.preventDefault()
          if (flatItems.length > 0) {
            const targetIndex = Math.min(currentIndex + 10, flatItems.length - 1)
            setFocusedItemId(flatItems[targetIndex].id)
          }
          break

        case 'PageUp':
          // Jump 10 items up
          e.preventDefault()
          if (flatItems.length > 0) {
            const targetIndex = Math.max(currentIndex - 10, 0)
            setFocusedItemId(flatItems[targetIndex].id)
          }
          break

        case 'Delete':
        case 'Backspace':
          // Delete focused item
          e.preventDefault()
          if (focusedItemId) {
            onDelete(focusedItemId)
          }
          break

        case 'o':
        case 'O':
          // Open link in new tab
          if (focusedItemId) {
            const focusedItem = flatItems.find((i) => i.id === focusedItemId)
            if (focusedItem?.type === 'link' && focusedItem.sourceUrl) {
              e.preventDefault()
              window.open(focusedItem.sourceUrl, '_blank', 'noopener,noreferrer')
            }
          }
          break

        case 'Enter':
          // Open Filing Panel for focused item
          if (focusedItemId) {
            e.preventDefault()
            onFile(focusedItemId)
          }
          break

        case 'Escape':
          // Deselect all in bulk mode
          if (isInBulkMode) {
            e.preventDefault()
            onSelectionChange(new Set())
          }
          break

        case 'a':
        case 'A':
          // Select all with Cmd/Ctrl+A
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault()
            const allIds = new Set(flatItems.map((i) => i.id))
            onSelectionChange(allIds)
          }
          break
      }
    },
    [
      flatItems,
      focusedItemId,
      onPreview,
      onFile,
      onDelete,
      setFocusedItemId,
      handleSelectionToggle,
      isInBulkMode,
      onSelectionChange
    ]
  )

  // Add keyboard listener
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const handleItemFocus = useCallback(
    (id: string): void => {
      setFocusedItemId(id)
    },
    [setFocusedItemId]
  )

  return (
    <div ref={containerRef} className="space-y-8" role="list" aria-label="Inbox items">
      {/* Stale Items Section - appears at top when there are stale items */}
      {staleItems.length > 0 && onFileAllStale && onReviewStale && (
        <StaleSection
          items={staleItems}
          viewMode="card"
          selectedItemIds={selectedItemIds}
          exitingItemIds={exitingItemIds}
          focusedItemId={focusedItemId}
          onFile={onFile}
          onPreview={onPreview}
          onDelete={onDelete}
          onFocus={handleItemFocus}
          onSelectionToggle={handleSelectionToggle}
          onFileAllToUnsorted={onFileAllStale}
          onReviewOneByOne={onReviewStale}
        />
      )}

      {/* Regular time-grouped items */}
      {groupedItems.map((group) => (
        <section key={group.period} aria-labelledby={`card-section-${group.period}`}>
          {/* Section Header */}
          <SectionHeader period={group.period} />

          {/* Grid of cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {group.items.map((item) => (
              <InboxCard
                key={item.id}
                item={item}
                period={group.period}
                isFocused={focusedItemId === item.id}
                isSelected={selectedItemIds.has(item.id)}
                isInBulkMode={isInBulkMode}
                isExiting={exitingItemIds.has(item.id)}
                onFile={onFile}
                onPreview={onPreview}
                onDelete={onDelete}
                onSnooze={onSnooze}
                onFocus={handleItemFocus}
                onSelectionToggle={handleSelectionToggle}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export { CardView, type CardViewProps }
