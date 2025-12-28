import { useRef, useEffect } from 'react'
import { Link, FileText, Image, Mic, Play, Globe, Scissors, FileIcon, Share2 } from 'lucide-react'

import { Checkbox } from '@/components/ui/checkbox'
import { QuickActions } from '@/components/quick-actions'
import { AgeIndicator } from '@/components/stale/age-indicator'
import { formatTimestamp, formatDuration, extractDomain } from '@/lib/inbox-utils'
import { cn } from '@/lib/utils'
import type { InboxItemListItem, InboxItemType } from '@/types'

// Type alias for convenience (backend type)
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

// Card content components (simplified versions from card-view.tsx)
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

const ImageCardContent = (): React.JSX.Element => {
  return (
    <div className="h-full bg-[var(--muted)] rounded-md flex items-center justify-center">
      <Image className="size-8 text-[var(--muted-foreground)]/50" aria-hidden="true" />
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
          className="size-8 rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] flex items-center justify-center hover:opacity-90 transition-opacity"
          aria-label="Play voice memo"
          onClick={(e) => e.stopPropagation()}
        >
          <Play className="size-4 ml-0.5" aria-hidden="true" />
        </button>
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
      <span className="text-sm font-medium text-[var(--foreground)] tabular-nums">{duration}</span>
    </div>
  )
}

const CardContent = ({ item }: { item: InboxItem }): React.JSX.Element => {
  switch (item.type) {
    case 'link':
      return <LinkCardContent item={item} />
    case 'note':
      return <NoteCardContent item={item} />
    case 'image':
      return <ImageCardContent />
    case 'voice':
      return <VoiceCardContent item={item} />
    case 'clip':
    case 'pdf':
    case 'social':
    default:
      return <NoteCardContent item={item} />
  }
}

interface StaleCardProps {
  item: InboxItem
  isFocused: boolean
  isSelected: boolean
  isInBulkMode: boolean
  isExiting?: boolean
  onFile: (id: string) => void
  onPreview: (id: string) => void
  onDelete: (id: string) => void
  onFocus: (id: string) => void
  onSelectionToggle: (id: string, shiftKey: boolean) => void
}

/**
 * Card component for stale items - includes age indicator footer
 */
export const StaleCard = ({
  item,
  isFocused,
  isSelected,
  isInBulkMode,
  isExiting = false,
  onFile,
  onPreview,
  onDelete,
  onFocus,
  onSelectionToggle
}: StaleCardProps): React.JSX.Element => {
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
    // Handled in handleCheckboxClick for shift-key support
  }

  return (
    <div
      ref={cardRef}
      className={cn(
        'group relative flex flex-col rounded-lg border bg-[var(--card)] shadow-sm cursor-pointer overflow-hidden',
        'transition-all duration-200 ease-out',
        // Exit animation
        isExiting
          ? 'opacity-0 scale-95 motion-reduce:opacity-0 motion-reduce:scale-100'
          : 'opacity-100 scale-100',
        // Selection/focus states with amber tint for stale items
        !isExiting && isSelected
          ? 'border-[var(--primary)] ring-2 ring-[var(--primary)]/30 shadow-lg'
          : !isExiting && isFocused
            ? 'border-amber-500/50 ring-2 ring-amber-500/30 ring-offset-1 ring-offset-[var(--background)] shadow-lg'
            : 'border-amber-500/20 hover:shadow-lg hover:border-amber-500/40 hover:scale-[1.01]'
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
          'absolute top-2 left-2 z-10 transition-opacity duration-150',
          isSelected || isInBulkMode
            ? 'opacity-100'
            : isFocused
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100'
        )}
      >
        <Checkbox
          id={`stale-card-${item.id}`}
          checked={isSelected}
          onCheckedChange={handleCheckboxChange}
          className="bg-[var(--background)] shadow-sm"
          aria-label={`Select ${item.title}`}
          onClick={handleCheckboxClick}
        />
      </div>

      {/* Top Bar: Icon + Timestamp */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-amber-500/10 bg-amber-500/5">
        <TypeIcon type={item.type} />
        <span className="text-[10px] text-[var(--muted-foreground)] tabular-nums">
          {formatTimestamp(item.createdAt, 'OLDER')}
        </span>
      </div>

      {/* Content Area - fixed height */}
      <div className="h-[100px] p-3">
        <CardContent item={item} />
      </div>

      {/* Bottom: Title - hidden on hover when actions show (unless in bulk mode) */}
      <div
        className={cn(
          'px-3 py-2 border-t border-amber-500/10 bg-amber-500/5 transition-opacity duration-100',
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
            'px-3 py-2 border-t border-amber-500/10 bg-amber-500/10 items-center justify-center transition-opacity duration-100 ease-out',
            isFocused ? 'flex' : 'hidden group-hover:flex'
          )}
        >
          <QuickActions
            itemId={item.id}
            onFile={onFile}
            onPreview={onPreview}
            onDelete={onDelete}
            variant="card"
          />
        </div>
      )}

      {/* Age indicator footer */}
      <div className="px-3 py-1.5 border-t border-amber-500/10 bg-amber-500/5">
        <AgeIndicator item={item} />
      </div>
    </div>
  )
}
