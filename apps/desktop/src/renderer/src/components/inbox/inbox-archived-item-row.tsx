import { useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import {
  FileText,
  Link,
  Mic,
  Image,
  Paperclip,
  FileIcon,
  Share2,
  Bell,
  StickyNote,
  RotateCcw,
  Trash2,
  X,
  Check,
  Loader2
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { InboxItemListItem } from '../../../../preload/index.d'

interface ArchivedInboxItem extends InboxItemListItem {
  archivedAt?: Date | string
}

export interface InboxArchivedItemRowProps {
  item: ArchivedInboxItem
  onUnarchive: (id: string) => void
  onDelete: (id: string) => void
  isDeleting?: boolean
  isUnarchiving?: boolean
}

export function InboxArchivedItemRow({
  item,
  onUnarchive,
  onDelete,
  isDeleting = false,
  isUnarchiving = false
}: InboxArchivedItemRowProps): React.JSX.Element {
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false)

  const getIcon = (): React.JSX.Element => {
    const iconClass = 'w-4 h-4 text-muted-foreground/60'

    switch (item.type) {
      case 'link':
        return <Link className={iconClass} aria-hidden="true" />
      case 'note':
        return <FileText className={iconClass} aria-hidden="true" />
      case 'image':
        return <Image className={iconClass} aria-hidden="true" />
      case 'voice':
        return <Mic className={iconClass} aria-hidden="true" />
      case 'clip':
        return <Paperclip className={iconClass} aria-hidden="true" />
      case 'pdf':
        return <FileIcon className={iconClass} aria-hidden="true" />
      case 'social':
        return <Share2 className={iconClass} aria-hidden="true" />
      case 'reminder':
        return <Bell className="w-4 h-4 text-amber-500" aria-hidden="true" />
      default:
        return <StickyNote className={iconClass} aria-hidden="true" />
    }
  }

  const handleRestore = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onUnarchive(item.id)
  }

  const handleDeleteClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    setIsConfirmingDelete(true)
  }

  const handleConfirmDelete = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onDelete(item.id)
    setIsConfirmingDelete(false)
  }

  const handleCancelDelete = (e: React.MouseEvent): void => {
    e.stopPropagation()
    setIsConfirmingDelete(false)
  }

  const dateToUse = item.archivedAt ? new Date(item.archivedAt) : new Date(item.createdAt)
  const relativeDate = formatDistanceToNow(dateToUse, { addSuffix: true })

  const previewText = item.excerpt ?? item.content ?? item.sourceUrl ?? ''

  return (
    <div
      className={cn(
        'group relative w-full',
        'flex items-center gap-3 px-3 py-2.5 rounded-lg',
        'transition-all duration-150 ease-out',
        'hover:bg-muted/50'
      )}
      role="listitem"
      aria-label={`${item.type}: ${item.title}`}
    >
      <div
        className={cn(
          'flex-shrink-0 flex items-center justify-center',
          'w-9 h-9 rounded-lg',
          'bg-muted/60 dark:bg-muted/40',
          'transition-colors duration-150',
          'group-hover:bg-muted dark:group-hover:bg-muted/60'
        )}
      >
        {getIcon()}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm truncate text-foreground/90">
            {item.title || 'Untitled Item'}
          </span>
          {item.isStale && (
            <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
              Stale
            </span>
          )}
        </div>
        {previewText && (
          <p className="text-xs text-muted-foreground/60 truncate mt-0.5 max-w-md">{previewText}</p>
        )}
      </div>

      {/* Timestamp */}
      <span className="shrink-0 text-xs text-muted-foreground/60 tabular-nums group-hover:opacity-0 transition-opacity">
        {relativeDate}
      </span>

      {/* Actions - show on hover */}
      <div
        className={cn(
          'absolute right-3 flex items-center gap-1',
          'opacity-0 group-hover:opacity-100 transition-opacity duration-150',
          (isConfirmingDelete || isDeleting || isUnarchiving) && 'opacity-100'
        )}
      >
        {isConfirmingDelete ? (
          <div className="flex items-center bg-muted rounded-md p-0.5 border border-border animate-in fade-in zoom-in-95 duration-150">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground px-2 mr-1">
              Delete?
            </span>
            <button
              onClick={handleConfirmDelete}
              className="p-1.5 hover:bg-destructive/10 hover:text-destructive rounded transition-colors text-muted-foreground"
              title="Yes, delete permanently"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleCancelDelete}
              className="p-1.5 hover:bg-accent hover:text-foreground rounded transition-colors text-muted-foreground"
              title="Cancel"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <>
            <button
              onClick={handleRestore}
              disabled={isUnarchiving || isDeleting}
              className={cn(
                'p-2 rounded-md transition-all text-muted-foreground',
                'hover:bg-background hover:text-amber-600 dark:hover:text-amber-400 hover:shadow-sm',
                isUnarchiving && 'animate-pulse cursor-wait'
              )}
              title="Restore to Inbox"
            >
              {isUnarchiving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RotateCcw className="w-4 h-4" />
              )}
            </button>

            <button
              onClick={handleDeleteClick}
              disabled={isUnarchiving || isDeleting}
              className={cn(
                'p-2 rounded-md transition-all text-muted-foreground',
                'hover:bg-background hover:text-destructive hover:shadow-sm',
                isDeleting && 'animate-pulse cursor-wait'
              )}
              title="Delete Permanently"
            >
              {isDeleting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
