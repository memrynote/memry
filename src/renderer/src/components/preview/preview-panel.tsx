import { useEffect, useRef, useState, useCallback } from 'react'
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
  Folder,
  Loader2,
  AlertCircle,
  RefreshCw,
  ExternalLink,
  Play,
  Pause,
  Copy,
  Check,
  User,
  Tag
} from 'lucide-react'

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
  SheetDescription
} from '@/components/ui/sheet'
import * as VisuallyHidden from '@radix-ui/react-visually-hidden'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { TagAutocomplete } from '@/components/filing/tag-autocomplete'
import { extractDomain } from '@/lib/inbox-utils'
import { useRetryTranscription, useAddInboxTag, useRemoveInboxTag } from '@/hooks/use-inbox'
import type {
  InboxItem,
  InboxItemListItem,
  InboxItemType,
  LinkMetadata,
  ImageMetadata,
  VoiceMetadata
} from '@/types'

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

// Helper to format file size
const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Helper to format duration
const formatDuration = (seconds: number): string => {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

// Loading skeleton component
const PreviewSkeleton = (): React.JSX.Element => (
  <div className="space-y-4 p-6">
    <Skeleton className="h-[200px] w-full rounded-lg" />
    <Skeleton className="h-4 w-3/4" />
    <Skeleton className="h-4 w-1/2" />
    <div className="space-y-2 mt-6">
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  </div>
)

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

  // Get link metadata
  const linkMetadata =
    item.type === 'link' && 'metadata' in item ? (item.metadata as LinkMetadata | null) : null

  return (
    <div className="px-6 py-3 bg-[var(--muted)]/30 space-y-1 border-b border-[var(--border)]">
      {/* Common: Capture date */}
      <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
        <Calendar className="size-4" aria-hidden="true" />
        <span>Captured {formatDate(item.createdAt)}</span>
      </div>

      {/* Link: Show URL and site info */}
      {item.type === 'link' && item.sourceUrl !== null && (
        <>
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
          {linkMetadata?.author && (
            <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
              <User className="size-4" aria-hidden="true" />
              <span>{linkMetadata.author}</span>
            </div>
          )}
        </>
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
          <span>Duration: {formatDuration(duration)}</span>
        </div>
      )}
    </div>
  )
}

// Link Preview Content
interface LinkPreviewProps {
  item: InboxItem | InboxItemListItem
}

const LinkPreview = ({ item }: LinkPreviewProps): React.JSX.Element => {
  const metadata = 'metadata' in item ? (item.metadata as LinkMetadata | null) : null
  // Use hero image from metadata, fall back to thumbnail
  const heroImage = metadata?.heroImage || item.thumbnailUrl

  // Debug: log hero image URL
  useEffect(() => {
    console.log('[LinkPreview] thumbnailUrl:', item.thumbnailUrl)
    console.log('[LinkPreview] heroImage:', heroImage)
  }, [item.thumbnailUrl, heroImage])

  return (
    <div className="space-y-4">
      {/* Hero image - full size */}
      {heroImage && (
        <div className="relative overflow-hidden rounded-lg bg-[var(--muted)]">
          <img
            src={heroImage}
            alt=""
            className="w-full object-cover max-h-[280px]"
            onLoad={() => console.log('[LinkPreview] Image loaded successfully')}
            onError={(e) => {
              console.error('[LinkPreview] Image failed to load:', heroImage)
              // Hide on error
              e.currentTarget.style.display = 'none'
            }}
          />
        </div>
      )}

      {/* Site name badge */}
      {metadata?.siteName && (
        <div className="flex items-center gap-2">
          {metadata.favicon && (
            <img
              src={metadata.favicon}
              alt=""
              className="size-4 rounded"
              onError={(e) => {
                e.currentTarget.style.display = 'none'
              }}
            />
          )}
          <span className="text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide">
            {metadata.siteName}
          </span>
        </div>
      )}

      {/* Description/Excerpt */}
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <p className="text-[var(--foreground)] leading-relaxed">
          {metadata?.description ||
            metadata?.excerpt ||
            item.content ||
            'No description available.'}
        </p>
      </div>

      {/* Published date if available */}
      {metadata?.publishedDate && (
        <p className="text-xs text-[var(--muted-foreground)]">
          Published:{' '}
          {new Date(metadata.publishedDate).toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric'
          })}
        </p>
      )}

      {/* Open in browser button */}
      {item.sourceUrl && (
        <a
          href={item.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-[var(--primary)] bg-[var(--primary)]/10 rounded-lg hover:bg-[var(--primary)]/20 transition-colors"
        >
          <ExternalLink className="size-4" />
          Open in browser
        </a>
      )}
    </div>
  )
}

// Image Preview Content
interface ImagePreviewProps {
  item: InboxItem | InboxItemListItem
}

const ImagePreview = ({ item }: ImagePreviewProps): React.JSX.Element => {
  const metadata = 'metadata' in item ? (item.metadata as ImageMetadata | null) : null
  // Prefer full attachment URL, fall back to thumbnail
  const imageUrl = ('attachmentUrl' in item && item.attachmentUrl) || item.thumbnailUrl

  return (
    <div className="space-y-4">
      {imageUrl ? (
        <div className="relative overflow-hidden rounded-lg bg-[var(--muted)]">
          <img
            src={imageUrl}
            alt={item.title}
            className="w-full object-contain max-h-[500px] mx-auto"
          />
        </div>
      ) : (
        <div className="flex items-center justify-center h-[200px] bg-[var(--muted)] rounded-lg">
          <Image className="size-12 text-[var(--muted-foreground)]" />
        </div>
      )}

      {/* Image metadata */}
      {metadata && (
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-[var(--muted-foreground)] px-1">
          {metadata.width && metadata.height && (
            <span className="flex items-center gap-1">
              <span className="font-medium">{metadata.width}</span> ×{' '}
              <span className="font-medium">{metadata.height}</span> px
            </span>
          )}
          {metadata.format && <span className="uppercase font-medium">{metadata.format}</span>}
          {metadata.fileSize && <span>{formatFileSize(metadata.fileSize)}</span>}
          {metadata.originalFilename && (
            <span className="truncate max-w-[200px]" title={metadata.originalFilename}>
              {metadata.originalFilename}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// Voice Preview Content with Audio Player
interface VoicePreviewProps {
  item: InboxItem | InboxItemListItem
  onRetryTranscription?: () => void
  isRetrying?: boolean
}

const VoicePreview = ({
  item,
  onRetryTranscription,
  isRetrying
}: VoicePreviewProps): React.JSX.Element => {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [copied, setCopied] = useState(false)
  const [audioError, setAudioError] = useState<string | null>(null)

  const metadata = 'metadata' in item ? (item.metadata as VoiceMetadata | null) : null
  const audioUrl = 'attachmentUrl' in item ? item.attachmentUrl : null

  // Debug: log audio URL
  useEffect(() => {
    if (audioUrl) {
      console.log('[VoicePreview] Audio URL:', audioUrl)
    }
  }, [audioUrl])
  const transcription = 'transcription' in item ? item.transcription : null
  const transcriptionStatus = 'transcriptionStatus' in item ? item.transcriptionStatus : null

  // Get duration from metadata or audio element
  const displayDuration =
    duration || metadata?.duration || ('duration' in item ? item.duration : 0) || 0

  const handlePlayPause = async (): Promise<void> => {
    if (!audioRef.current) return
    setAudioError(null)

    if (isPlaying) {
      audioRef.current.pause()
    } else {
      try {
        await audioRef.current.play()
      } catch (err) {
        console.error('[VoicePreview] Play error:', err)
        setAudioError(err instanceof Error ? err.message : 'Failed to play audio')
      }
    }
  }

  const handleAudioError = (e: React.SyntheticEvent<HTMLAudioElement>): void => {
    const audio = e.currentTarget
    const error = audio.error
    console.error('[VoicePreview] Audio error:', error?.code, error?.message)
    setAudioError(error?.message || 'Failed to load audio')
  }

  const handleTimeUpdate = (): void => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime)
    }
  }

  const handleLoadedMetadata = (): void => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration)
    }
  }

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const time = parseFloat(e.target.value)
    if (audioRef.current) {
      audioRef.current.currentTime = time
      setCurrentTime(time)
    }
  }

  const handleCopyTranscription = async (): Promise<void> => {
    if (transcription) {
      await navigator.clipboard.writeText(transcription)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="space-y-4">
      {/* Audio Player */}
      {audioUrl ? (
        <div className="bg-[var(--muted)] rounded-lg p-4 space-y-3">
          <audio
            ref={audioRef}
            src={audioUrl}
            preload="metadata"
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onError={handleAudioError}
          />

          {/* Audio error display */}
          {audioError && (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 rounded-lg text-sm text-red-600 dark:text-red-400">
              <AlertCircle className="size-4 shrink-0" />
              <span>Audio error: {audioError}</span>
            </div>
          )}

          {/* Play button and waveform area */}
          <div className="flex items-center gap-4">
            <Button
              size="icon"
              variant="secondary"
              onClick={handlePlayPause}
              className="size-12 rounded-full bg-[var(--primary)] hover:bg-[var(--primary)]/90"
            >
              {isPlaying ? (
                <Pause className="size-5 text-[var(--primary-foreground)]" />
              ) : (
                <Play className="size-5 text-[var(--primary-foreground)] ml-0.5" />
              )}
            </Button>

            <div className="flex-1 space-y-1">
              {/* Progress bar */}
              <input
                type="range"
                min={0}
                max={displayDuration || 100}
                value={currentTime}
                onChange={handleSeek}
                className="w-full h-2 bg-[var(--border)] rounded-lg appearance-none cursor-pointer accent-[var(--primary)]"
              />
              {/* Time display */}
              <div className="flex justify-between text-xs text-[var(--muted-foreground)]">
                <span>{formatDuration(currentTime)}</span>
                <span>{formatDuration(displayDuration)}</span>
              </div>
            </div>
          </div>

          {/* Metadata */}
          {metadata && (
            <div className="flex gap-4 text-xs text-[var(--muted-foreground)] pt-2 border-t border-[var(--border)]">
              {metadata.format && <span className="uppercase">{metadata.format}</span>}
              {metadata.fileSize && <span>{formatFileSize(metadata.fileSize)}</span>}
              {metadata.sampleRate && <span>{(metadata.sampleRate / 1000).toFixed(1)}kHz</span>}
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-4 p-4 bg-[var(--muted)] rounded-lg">
          <div className="size-12 rounded-full bg-[var(--primary)] flex items-center justify-center">
            <Mic className="size-6 text-[var(--primary-foreground)]" />
          </div>
          <div className="flex-1">
            <p className="font-medium">{item.title}</p>
            <p className="text-sm text-[var(--muted-foreground)]">
              {displayDuration > 0 ? formatDuration(displayDuration) : 'Voice memo'}
            </p>
          </div>
        </div>
      )}

      {/* Transcription Section */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide">
            Transcription
          </span>
          {transcription && (
            <Button
              size="sm"
              variant="ghost"
              onClick={handleCopyTranscription}
              className="h-7 px-2 text-xs"
            >
              {copied ? (
                <>
                  <Check className="size-3 mr-1" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="size-3 mr-1" />
                  Copy
                </>
              )}
            </Button>
          )}
        </div>

        {transcriptionStatus === 'complete' && transcription ? (
          <div className="p-4 bg-[var(--muted)]/50 rounded-lg">
            <p className="text-sm whitespace-pre-wrap leading-relaxed">{transcription}</p>
          </div>
        ) : transcriptionStatus === 'pending' ? (
          <div className="flex items-center gap-2 p-4 bg-[var(--muted)]/30 rounded-lg text-sm text-[var(--muted-foreground)]">
            <Loader2 className="size-4 animate-spin" />
            <span>Transcription pending...</span>
          </div>
        ) : transcriptionStatus === 'processing' ? (
          <div className="flex items-center gap-2 p-4 bg-[var(--muted)]/30 rounded-lg text-sm text-[var(--muted-foreground)]">
            <Loader2 className="size-4 animate-spin" />
            <span>Transcribing audio...</span>
          </div>
        ) : transcriptionStatus === 'failed' ? (
          <div className="flex items-center justify-between p-4 bg-red-500/10 rounded-lg">
            <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
              <AlertCircle className="size-4" />
              <span>Transcription failed</span>
            </div>
            {onRetryTranscription && (
              <Button
                size="sm"
                variant="outline"
                onClick={onRetryTranscription}
                disabled={isRetrying}
                className="h-7"
              >
                {isRetrying ? (
                  <Loader2 className="size-3 animate-spin mr-1" />
                ) : (
                  <RefreshCw className="size-3 mr-1" />
                )}
                Retry
              </Button>
            )}
          </div>
        ) : (
          <div className="p-4 bg-[var(--muted)]/30 rounded-lg text-sm text-[var(--muted-foreground)] italic">
            No transcription available
          </div>
        )}
      </div>
    </div>
  )
}

// Simple content renderer for other types
interface SimpleContentProps {
  item: PreviewItem
}

const SimpleContent = ({ item }: SimpleContentProps): React.JSX.Element => {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      <p className="whitespace-pre-wrap">{item.content || 'No content available.'}</p>
    </div>
  )
}

// Main content dispatcher
interface PreviewContentProps {
  item: PreviewItem
  onRetryTranscription?: () => void
  isRetrying?: boolean
}

const PreviewContent = ({
  item,
  onRetryTranscription,
  isRetrying
}: PreviewContentProps): React.JSX.Element => {
  switch (item.type) {
    case 'link':
      return <LinkPreview item={item} />
    case 'note':
      return <SimpleContent item={item} />
    case 'image':
      return <ImagePreview item={item} />
    case 'voice':
      return (
        <VoicePreview
          item={item}
          onRetryTranscription={onRetryTranscription}
          isRetrying={isRetrying}
        />
      )
    case 'clip':
    case 'pdf':
    case 'social':
    default:
      return <SimpleContent item={item} />
  }
}

// =============================================================================
// Preview Tags Component - Inline tag editing
// =============================================================================

interface PreviewTagsProps {
  itemId: string
  tags: string[]
}

const PreviewTags = ({ itemId, tags }: PreviewTagsProps): React.JSX.Element => {
  const [localTags, setLocalTags] = useState<string[]>(tags)
  const addTagMutation = useAddInboxTag()
  const removeTagMutation = useRemoveInboxTag()

  // Sync local tags when prop changes (e.g., after mutation success)
  useEffect(() => {
    setLocalTags(tags)
  }, [tags])

  const handleTagsChange = useCallback(
    (newTags: string[]) => {
      // Find added tags
      const addedTags = newTags.filter((t) => !localTags.includes(t))
      // Find removed tags
      const removedTags = localTags.filter((t) => !newTags.includes(t))

      // Optimistically update local state
      setLocalTags(newTags)

      // Apply changes to backend
      addedTags.forEach((tag) => {
        addTagMutation.mutate({ itemId, tag })
      })
      removedTags.forEach((tag) => {
        removeTagMutation.mutate({ itemId, tag })
      })
    },
    [itemId, localTags, addTagMutation, removeTagMutation]
  )

  const isPending = addTagMutation.isPending || removeTagMutation.isPending

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Tag className="size-4 text-[var(--muted-foreground)]" aria-hidden="true" />
        <span className="text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide">
          Tags
        </span>
        {isPending && <Loader2 className="size-3 animate-spin text-[var(--muted-foreground)]" />}
      </div>
      <TagAutocomplete
        tags={localTags}
        onTagsChange={handleTagsChange}
        placeholder="Add tags to this item..."
        showSections={true}
        className="pt-0"
      />
    </div>
  )
}

// =============================================================================
// Main Preview Panel component
// =============================================================================

interface PreviewPanelProps {
  isOpen: boolean
  item: PreviewItem | null
  isLoading?: boolean
  onClose: () => void
  onFile: (id: string) => void
  onDelete: (id: string) => void
}

const PreviewPanel = ({
  isOpen,
  item,
  isLoading = false,
  onClose,
  onFile,
  onDelete
}: PreviewPanelProps): React.JSX.Element => {
  // Retry transcription mutation
  const retryTranscriptionMutation = useRetryTranscription()

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

  const handleRetryTranscription = (): void => {
    if (item) {
      retryTranscriptionMutation.mutate(item.id)
    }
  }

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        className="w-[520px] sm:max-w-[520px] flex flex-col p-0"
        aria-describedby={item ? undefined : 'preview-panel-description'}
      >
        {isLoading ? (
          <>
            {/* Hidden title/description for accessibility when loading */}
            <VisuallyHidden.Root>
              <SheetTitle>Loading preview</SheetTitle>
              <SheetDescription id="preview-panel-description">
                Loading item preview...
              </SheetDescription>
            </VisuallyHidden.Root>
            <PreviewSkeleton />
          </>
        ) : item ? (
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
            <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
              {/* Tags Section */}
              <PreviewTags itemId={item.id} tags={item.tags || []} />

              <Separator />

              {/* Content */}
              <PreviewContent
                item={item}
                onRetryTranscription={handleRetryTranscription}
                isRetrying={retryTranscriptionMutation.isPending}
              />
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
        ) : (
          // Hidden title/description for accessibility when no item
          <VisuallyHidden.Root>
            <SheetTitle>Preview panel</SheetTitle>
            <SheetDescription>No item selected for preview</SheetDescription>
          </VisuallyHidden.Root>
        )}
      </SheetContent>
    </Sheet>
  )
}

export { PreviewPanel }
