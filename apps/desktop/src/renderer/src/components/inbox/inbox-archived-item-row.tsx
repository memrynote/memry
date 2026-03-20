import { useState } from 'react'
import { format } from 'date-fns'
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
  X,
  Check,
  Loader2
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { InboxItemListItem } from '../../../../preload/index.d'

interface ArchivedInboxItem extends InboxItemListItem {
  archivedAt?: Date | string
}

const ICON_SIZE = 14

const TYPE_ICON_CONFIG: Record<string, { icon: typeof FileText; className: string }> = {
  link: { icon: Link, className: 'text-accent-purple' },
  note: { icon: FileText, className: 'text-muted-foreground' },
  image: { icon: Image, className: 'text-task-complete' },
  voice: { icon: Mic, className: 'text-task-star' },
  clip: { icon: Paperclip, className: 'text-accent-purple' },
  pdf: { icon: FileIcon, className: 'text-destructive' },
  social: { icon: Share2, className: 'text-accent-cyan' },
  reminder: { icon: Bell, className: 'text-task-star' }
}

const DEFAULT_ICON_CONFIG = { icon: StickyNote, className: 'text-muted-foreground' }

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

  const config = TYPE_ICON_CONFIG[item.type] ?? DEFAULT_ICON_CONFIG
  const IconComponent = config.icon

  const dateToUse = item.archivedAt ? new Date(item.archivedAt) : new Date(item.createdAt)
  const archivedDate = format(dateToUse, "'Archived' MMM d")

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

  return (
    <div
      className="flex items-center gap-2.5 px-6 py-1.5 h-[33px] opacity-70"
      role="listitem"
      aria-label={`${item.type}: ${item.title}`}
    >
      <IconComponent
        size={ICON_SIZE}
        className={cn('shrink-0', config.className)}
        aria-hidden="true"
      />

      <span className="flex-1 min-w-0 text-muted-foreground line-through decoration-1 text-[13px] leading-4 line-clamp-1">
        {item.title || 'Untitled Item'}
      </span>

      <span className="shrink-0 text-[11px] text-muted-foreground/60 tabular-nums">
        {archivedDate}
      </span>

      {isConfirmingDelete ? (
        <div className="flex items-center gap-1 animate-in fade-in zoom-in-95 duration-150">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mr-0.5">
            Delete?
          </span>
          <button
            onClick={handleConfirmDelete}
            className="p-1 hover:text-destructive rounded transition-colors text-muted-foreground"
            title="Yes, delete permanently"
          >
            <Check className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleCancelDelete}
            className="p-1 hover:text-foreground rounded transition-colors text-muted-foreground"
            title="Cancel"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleRestore}
            disabled={isUnarchiving || isDeleting}
            className={cn(
              'border border-task-complete/25 text-task-complete text-[11px] px-2 py-0.5 rounded-[5px]',
              'transition-colors hover:bg-task-complete/10',
              isUnarchiving && 'cursor-wait'
            )}
            title="Restore to Inbox"
          >
            {isUnarchiving ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Restore'}
          </button>

          <button
            onClick={handleDeleteClick}
            disabled={isUnarchiving || isDeleting}
            className={cn(
              'border border-destructive/25 text-destructive text-[11px] px-2 py-0.5 rounded-[5px]',
              'transition-colors hover:bg-destructive/10',
              isDeleting && 'cursor-wait'
            )}
            title="Delete Permanently"
          >
            {isDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Delete'}
          </button>
        </div>
      )}
    </div>
  )
}
