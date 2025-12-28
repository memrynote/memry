import { useEffect } from 'react'
import {
  Link,
  FileText,
  Image,
  Mic,
  Calendar,
  Globe,
  Clock,
  Scissors,
  FileIcon as FileIconLucide,
  Share2,
  Trash2,
  Folder
} from 'lucide-react'

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { extractDomain } from '@/lib/inbox-utils'
import type { InboxItem, InboxItemListItem, InboxItemType } from '@/types'

// Preview panel can work with either full or list item types
type PreviewItem = InboxItem | InboxItemListItem

// Type icon component
const TypeIcon = ({ type }: { type: InboxItemType }): React.JSX.Element => {
  const iconClass = 'size-5 text-[var(--muted-foreground)]'

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
      return <FileIconLucide className={iconClass} aria-hidden="true" />
    case 'social':
      return <Share2 className={iconClass} aria-hidden="true" />
    default:
      return <FileText className={iconClass} aria-hidden="true" />
  }
}

// Metadata component
interface PreviewMetadataProps {
  item: PreviewItem
}

const PreviewMetadata = ({ item }: PreviewMetadataProps): React.JSX.Element => {
  const formatDate = (date: Date | string): string => {
    const d = date instanceof Date ? date : new Date(date)
    const now = new Date()
    const isToday = d.toDateString() === now.toDateString()

    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    const isYesterday = d.toDateString() === yesterday.toDateString()

    const timeStr = d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    })

    if (isToday) {
      return `today at ${timeStr}`
    }
    if (isYesterday) {
      return `yesterday at ${timeStr}`
    }
    return (
      d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      }) + ` at ${timeStr}`
    )
  }

  // Get duration - on list items it's a direct property, on full items it's in metadata
  let duration: number | null = null
  if ('duration' in item && typeof item.duration === 'number') {
    duration = item.duration
  } else if ('metadata' in item) {
    const metadata = item.metadata as Record<string, unknown> | null
    if (typeof metadata?.duration === 'number') {
      duration = metadata.duration
    }
  }

  return (
    <div className="px-6 py-3 bg-[var(--muted)]/30 space-y-1 border-b border-[var(--border)]">
      {/* Common: Capture date */}
      <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
        <Calendar className="size-4" aria-hidden="true" />
        <span>Captured {formatDate(item.createdAt)}</span>
      </div>

      {/* Link: Show URL */}
      {item.type === 'link' && item.sourceUrl !== null && (
        <div className="flex items-center gap-2 text-sm">
          <Globe className="size-4 text-[var(--muted-foreground)]" aria-hidden="true" />
          <a
            href={item.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--primary)] hover:underline truncate"
          >
            {extractDomain(item.sourceUrl)}
          </a>
        </div>
      )}

      {/* Note: Word count */}
      {item.type === 'note' && item.content && (
        <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
          <FileText className="size-4" aria-hidden="true" />
          <span>{item.content.split(/\s+/).filter(Boolean).length} words</span>
        </div>
      )}

      {/* Voice: Show duration */}
      {item.type === 'voice' && duration !== null && (
        <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
          <Clock className="size-4" aria-hidden="true" />
          <span>
            Duration: {Math.floor(duration / 60)}:{(duration % 60).toString().padStart(2, '0')}
          </span>
        </div>
      )}
    </div>
  )
}

// Simple content renderer
interface PreviewContentProps {
  item: PreviewItem
}

const PreviewContent = ({ item }: PreviewContentProps): React.JSX.Element => {
  // For now, show a simple preview based on available data
  switch (item.type) {
    case 'link':
      return (
        <div className="space-y-4">
          {item.thumbnailUrl && (
            <img
              src={item.thumbnailUrl}
              alt=""
              className="w-full rounded-lg object-cover max-h-[200px]"
            />
          )}
          <p className="text-sm text-[var(--muted-foreground)]">
            {item.content || 'No description available.'}
          </p>
          {item.sourceUrl && (
            <a
              href={item.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-sm text-[var(--primary)] hover:underline"
            >
              <Globe className="size-4" />
              Open in browser
            </a>
          )}
        </div>
      )

    case 'note':
      return (
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <p className="whitespace-pre-wrap">{item.content}</p>
        </div>
      )

    case 'image':
      return (
        <div className="space-y-4">
          {item.thumbnailUrl ? (
            <img
              src={item.thumbnailUrl}
              alt={item.title}
              className="w-full rounded-lg object-contain max-h-[400px]"
            />
          ) : (
            <div className="flex items-center justify-center h-[200px] bg-[var(--muted)] rounded-lg">
              <Image className="size-12 text-[var(--muted-foreground)]" />
            </div>
          )}
        </div>
      )

    case 'voice':
      return (
        <div className="space-y-4">
          {/* Simple audio player placeholder */}
          <div className="flex items-center gap-4 p-4 bg-[var(--muted)] rounded-lg">
            <div className="size-12 rounded-full bg-[var(--primary)] flex items-center justify-center">
              <Mic className="size-6 text-[var(--primary-foreground)]" />
            </div>
            <div className="flex-1">
              <p className="font-medium">{item.title}</p>
              <p className="text-sm text-[var(--muted-foreground)]">Voice memo</p>
            </div>
          </div>
          {/* Transcription if available (only on full InboxItem) */}
          {'transcription' in item && item.transcription && (
            <div className="p-4 bg-[var(--muted)]/50 rounded-lg">
              <p className="text-xs font-medium text-[var(--muted-foreground)] mb-2">
                Transcription
              </p>
              <p className="text-sm">{item.transcription}</p>
            </div>
          )}
        </div>
      )

    case 'clip':
    case 'pdf':
    case 'social':
    default:
      return (
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <p className="whitespace-pre-wrap">{item.content || 'No content available.'}</p>
        </div>
      )
  }
}

// Main Preview Panel component
interface PreviewPanelProps {
  isOpen: boolean
  item: PreviewItem | null
  onClose: () => void
  onFile: (id: string) => void
  onDelete: (id: string) => void
}

const PreviewPanel = ({
  isOpen,
  item,
  onClose,
  onFile,
  onDelete
}: PreviewPanelProps): React.JSX.Element => {
  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!isOpen) return

      // Space or Escape to close
      if (e.key === ' ' || e.key === 'Escape') {
        // Don't close if typing in an input
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
          return
        }
        e.preventDefault()
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  const handleOpenChange = (open: boolean): void => {
    if (!open) {
      onClose()
    }
  }

  const handleFile = (): void => {
    if (item) {
      onFile(item.id)
    }
  }

  const handleDelete = (): void => {
    if (item) {
      onDelete(item.id)
      onClose()
    }
  }

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange}>
      <SheetContent side="right" className="w-[520px] sm:max-w-[520px] flex flex-col p-0">
        {item && (
          <>
            {/* Header */}
            <SheetHeader className="px-6 py-4 border-b border-[var(--border)] shrink-0">
              <div className="flex items-start gap-3">
                <TypeIcon type={item.type} />
                <SheetTitle className="text-lg font-semibold flex-1 line-clamp-2">
                  {item.title}
                </SheetTitle>
              </div>
            </SheetHeader>

            {/* Metadata */}
            <PreviewMetadata item={item} />

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto px-6 py-6">
              <PreviewContent item={item} />
            </div>

            {/* Footer */}
            <SheetFooter className="px-6 py-4 border-t border-[var(--border)] shrink-0">
              <div className="flex items-center justify-between w-full">
                <Button
                  variant="ghost"
                  onClick={handleDelete}
                  className="text-[var(--muted-foreground)] hover:text-red-500 hover:bg-red-500/10"
                >
                  <Trash2 className="size-4 mr-2" aria-hidden="true" />
                  Delete
                </Button>
                <Button onClick={handleFile}>
                  <Folder className="size-4 mr-2" aria-hidden="true" />
                  File
                </Button>
              </div>
              <p className="text-xs text-[var(--muted-foreground)] text-center w-full mt-3">
                Space to close
              </p>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

export { PreviewPanel }
