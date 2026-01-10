/**
 * Content Section for Inbox Detail Panel
 * Displays type-specific content previews (link, image, voice, text)
 */

import { useRef, useState } from 'react'
import {
  Globe,
  Image,
  Mic,
  FileText,
  Calendar,
  Clock,
  User,
  ExternalLink,
  Play,
  Pause,
  Copy,
  Check,
  Loader2,
  AlertCircle,
  RefreshCw,
  FileType,
  Video
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { extractDomain } from '@/lib/inbox-utils'
import { InboxContentEditor } from './inbox-content-editor'
import type {
  InboxItem,
  InboxItemListItem,
  InboxItemType,
  LinkMetadata,
  ImageMetadata,
  VoiceMetadata
} from '@/types'

// Content section can work with either full or list item types
type ContentItem = InboxItem | InboxItemListItem

// =============================================================================
// Helper Functions
// =============================================================================

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const formatDuration = (seconds: number): string => {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

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

// =============================================================================
// Type Icon Component
// =============================================================================

interface TypeIconProps {
  type: InboxItemType
  className?: string
}

export const TypeIcon = ({ type, className = 'size-5' }: TypeIconProps): React.JSX.Element => {
  const iconClass = `${className} text-[var(--muted-foreground)]`

  switch (type) {
    case 'link':
      return <Globe className={iconClass} aria-hidden="true" />
    case 'note':
      return <FileText className={iconClass} aria-hidden="true" />
    case 'image':
      return <Image className={iconClass} aria-hidden="true" />
    case 'voice':
      return <Mic className={iconClass} aria-hidden="true" />
    case 'pdf':
      return <FileType className={iconClass} aria-hidden="true" />
    case 'video':
      return <Video className={iconClass} aria-hidden="true" />
    case 'clip':
    case 'social':
    default:
      return <FileText className={iconClass} aria-hidden="true" />
  }
}

// =============================================================================
// Loading Skeleton
// =============================================================================

export const ContentSkeleton = (): React.JSX.Element => (
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

// =============================================================================
// Metadata Component
// =============================================================================

interface ContentMetadataProps {
  item: ContentItem
}

export const ContentMetadata = ({ item }: ContentMetadataProps): React.JSX.Element => {
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

// =============================================================================
// Link Preview Content
// =============================================================================

interface LinkPreviewProps {
  item: InboxItem | InboxItemListItem
}

const LinkPreview = ({ item }: LinkPreviewProps): React.JSX.Element => {
  const metadata = 'metadata' in item ? (item.metadata as LinkMetadata | null) : null
  const heroImage = metadata?.heroImage || item.thumbnailUrl

  return (
    <div className="space-y-4">
      {/* Hero image - full size */}
      {heroImage && (
        <div className="relative overflow-hidden rounded-lg bg-[var(--muted)]">
          <img
            src={heroImage}
            alt=""
            className="w-full object-cover max-h-[280px]"
            onError={(e) => {
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

// =============================================================================
// Image Preview Content
// =============================================================================

interface ImagePreviewProps {
  item: InboxItem | InboxItemListItem
}

const ImagePreview = ({ item }: ImagePreviewProps): React.JSX.Element => {
  const metadata = 'metadata' in item ? (item.metadata as ImageMetadata | null) : null
  const imageUrl = ('attachmentUrl' in item && item.attachmentUrl) || item.thumbnailUrl

  return (
    <div className="space-y-4">
      {imageUrl ? (
        <div className="relative overflow-hidden rounded-lg bg-[var(--muted)]">
          <img
            src={imageUrl}
            alt={item.title}
            className="w-full object-contain max-h-[400px] mx-auto"
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
              <span className="font-medium">{metadata.width}</span> x{' '}
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

// =============================================================================
// Voice Preview Content with Audio Player
// =============================================================================

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
              onClick={() => void handlePlayPause()}
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

// =============================================================================
// PDF Preview Content
// =============================================================================

interface PdfPreviewProps {
  item: InboxItem | InboxItemListItem
}

const PdfPreview = ({ item }: PdfPreviewProps): React.JSX.Element => {
  const pdfUrl = 'attachmentUrl' in item ? item.attachmentUrl : null
  const metadata = 'metadata' in item ? (item.metadata as Record<string, unknown> | null) : null

  return (
    <div className="space-y-4">
      {pdfUrl ? (
        <div className="relative overflow-hidden rounded-lg bg-[var(--muted)] border border-[var(--border)]">
          <iframe
            src={pdfUrl}
            title={item.title}
            className="w-full h-[400px]"
            style={{ border: 'none' }}
          />
        </div>
      ) : (
        <div className="flex items-center justify-center h-[200px] bg-[var(--muted)] rounded-lg">
          <FileText className="size-12 text-[var(--muted-foreground)]" />
        </div>
      )}

      {/* PDF metadata */}
      {(() => {
        const fileSize = metadata?.fileSize
        const originalFilename = metadata?.originalFilename
        return (
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-[var(--muted-foreground)] px-1">
            <span className="uppercase font-medium">PDF</span>
            {typeof fileSize === 'number' && <span>{formatFileSize(fileSize)}</span>}
            {typeof originalFilename === 'string' && (
              <span className="truncate max-w-[200px]" title={originalFilename}>
                {originalFilename}
              </span>
            )}
          </div>
        )
      })()}
    </div>
  )
}

// =============================================================================
// Video Preview Content
// =============================================================================

interface VideoPreviewProps {
  item: InboxItem | InboxItemListItem
}

const VideoPreview = ({ item }: VideoPreviewProps): React.JSX.Element => {
  const videoUrl = 'attachmentUrl' in item ? item.attachmentUrl : null
  const metadata = 'metadata' in item ? (item.metadata as Record<string, unknown> | null) : null

  return (
    <div className="space-y-4">
      {videoUrl ? (
        <div className="relative overflow-hidden rounded-lg bg-black">
          <video
            src={videoUrl}
            controls
            className="w-full max-h-[400px]"
            preload="metadata"
          >
            Your browser does not support the video tag.
          </video>
        </div>
      ) : (
        <div className="flex items-center justify-center h-[200px] bg-[var(--muted)] rounded-lg">
          <FileText className="size-12 text-[var(--muted-foreground)]" />
        </div>
      )}

      {/* Video metadata */}
      {(() => {
        const fileSize = metadata?.fileSize
        const originalFilename = metadata?.originalFilename
        return (
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-[var(--muted-foreground)] px-1">
            <span className="uppercase font-medium">Video</span>
            {typeof fileSize === 'number' && <span>{formatFileSize(fileSize)}</span>}
            {typeof originalFilename === 'string' && (
              <span className="truncate max-w-[200px]" title={originalFilename}>
                {originalFilename}
              </span>
            )}
          </div>
        )
      })()}
    </div>
  )
}

// =============================================================================
// Simple Text Content (Editable with BlockNote)
// =============================================================================

interface SimpleContentProps {
  item: ContentItem
  onContentChange?: (content: string) => void
}

const SimpleContent = ({ item, onContentChange }: SimpleContentProps): React.JSX.Element => {
  return (
    <InboxContentEditor
      initialContent={item.content}
      onContentChange={onContentChange}
      editable={true}
      placeholder="Edit your captured text..."
    />
  )
}

// =============================================================================
// Main Content Section Component
// =============================================================================

interface ContentSectionProps {
  item: ContentItem
  onRetryTranscription?: () => void
  isRetrying?: boolean
  /** Callback when content is edited */
  onContentChange?: (content: string) => void
}

export const ContentSection = ({
  item,
  onRetryTranscription,
  isRetrying,
  onContentChange
}: ContentSectionProps): React.JSX.Element => {
  switch (item.type) {
    case 'link':
      return <LinkPreview item={item} />
    case 'note':
      return <SimpleContent item={item} onContentChange={onContentChange} />
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
    case 'pdf':
      return <PdfPreview item={item} />
    case 'video':
      return <VideoPreview item={item} />
    case 'clip':
    case 'social':
    default:
      return <SimpleContent item={item} onContentChange={onContentChange} />
  }
}
