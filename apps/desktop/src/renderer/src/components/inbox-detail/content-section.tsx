/**
 * Content Section for Inbox Detail Panel
 * Displays type-specific content previews (link, image, voice, text)
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { TweetCard } from './tweet-card'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useT } from '@memry/i18n/renderer'
import {
  Image,
  Mic,
  FileText,
  Calendar,
  Clock,
  User,
  Globe,
  Play,
  Pause,
  Copy,
  Check,
  Loader2,
  AlertCircle,
  RefreshCw,
  FileType,
  FilePdf,
  Video,
  Link2,
  Bell
} from '@/lib/icons'

import { Skeleton } from '@/components/ui/skeleton'
import { extractDomain } from '@/lib/inbox-utils'
import { extractYouTubeVideoId } from '@/lib/youtube-utils'
import { InboxContentEditor } from './inbox-content-editor'
import { LinkPreview } from './link-preview'
import { ReminderDetail } from './reminder-detail'
import { getTypeAccentClass } from './type-accents'
import type {
  InboxItem,
  InboxItemListItem,
  InboxItemType,
  LinkMetadata,
  ImageMetadata,
  PdfMetadata,
  VoiceMetadata
} from '@/types'
import { createLogger } from '@/lib/logger'
import { formatTimeOfDay } from '@/lib/time-format'
import type { ClockFormat } from '@/lib/time-format'
import { useGeneralSettings } from '@/hooks/use-general-settings'

const log = createLogger('Component:ContentSection')

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

type FormattedDateParts =
  | { kind: 'today'; time: string }
  | { kind: 'yesterday'; time: string }
  | { kind: 'date'; date: string; time: string }

const formatDateParts = (
  date: Date | string,
  clockFormat: ClockFormat = '12h'
): FormattedDateParts => {
  const d = date instanceof Date ? date : new Date(date)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday = d.toDateString() === yesterday.toDateString()

  const timeStr = formatTimeOfDay(d, clockFormat)

  if (isToday) {
    return { kind: 'today', time: timeStr }
  }
  if (isYesterday) {
    return { kind: 'yesterday', time: timeStr }
  }
  return {
    kind: 'date',
    date: d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }),
    time: timeStr
  }
}

const PLAYBACK_BAR_COUNT = 60
const PLAYBACK_MIN_HEIGHT = 3
const PLAYBACK_MAX_HEIGHT = 32

// =============================================================================
// Type Icon Component
// =============================================================================

interface TypeIconProps {
  type: InboxItemType
  className?: string
}

export const TypeIcon = ({ type, className = 'size-5' }: TypeIconProps): React.JSX.Element => {
  const accentClass = getTypeAccentClass(type)
  const iconClass = `${className} ${accentClass}`

  switch (type) {
    case 'link':
      return <Link2 className={iconClass} aria-hidden="true" />
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
    case 'reminder':
      return <Bell className={iconClass} aria-hidden="true" />
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
    <Skeleton className="h-[200px] w-full rounded-md" />
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
  const { t } = useT('inbox')
  const {
    settings: { clockFormat }
  } = useGeneralSettings()

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
  const capturedDate = formatDateParts(item.createdAt, clockFormat)
  const capturedAt =
    capturedDate.kind === 'today'
      ? t('content.todayAt', { time: capturedDate.time })
      : capturedDate.kind === 'yesterday'
        ? t('content.yesterdayAt', { time: capturedDate.time })
        : t('content.dateAt', { date: capturedDate.date, time: capturedDate.time })

  return (
    <div className="px-6 py-3 bg-[var(--muted)]/30 space-y-1 border-b border-[var(--border)]">
      {/* Common: Capture date */}
      <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
        <Calendar className="size-4" aria-hidden="true" />
        <span>{t('content.capturedAt', { date: capturedAt })}</span>
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
          <span>
            {t('content.words', { count: item.content.split(/\s+/).filter(Boolean).length })}
          </span>
        </div>
      )}

      {/* Voice: Show duration */}
      {item.type === 'voice' && duration !== null && (
        <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
          <Clock className="size-4" aria-hidden="true" />
          <span>{t('content.duration', { duration: formatDuration(duration) })}</span>
        </div>
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
  const { t: tPhaseF } = useT('inbox')
  const { t } = useT('inbox')
  const metadata = 'metadata' in item ? (item.metadata as ImageMetadata | null) : null
  const imageUrl = ('attachmentUrl' in item && item.attachmentUrl) || item.thumbnailUrl

  return (
    <div className="flex flex-col gap-3.5">
      {imageUrl ? (
        <div className="overflow-hidden rounded-lg bg-muted">
          <img src={imageUrl} alt={item.title} className="w-full object-contain max-h-[400px]" />
        </div>
      ) : (
        <div className="flex items-center justify-center aspect-[34/22] rounded-lg bg-muted">
          <Image className="size-8 text-muted-foreground/25" />
        </div>
      )}

      {metadata?.originalFilename && (
        <span
          className="text-[11px] leading-3.5 text-muted-foreground truncate"
          title={metadata.originalFilename}
        >
          {metadata.originalFilename}
        </span>
      )}

      {metadata && (
        <div className="flex items-center gap-4">
          {metadata.width && metadata.height && (
            <div className="flex items-center gap-1">
              <span className="text-[11px] leading-3.5 text-text-tertiary">
                {t('content.dimensions')}
              </span>
              <span className="text-[11px] leading-3.5 text-muted-foreground">
                {metadata.width} {tPhaseF('phaseF.componentsInboxDetailContentSection.x')}
                {metadata.height}
              </span>
            </div>
          )}
          {metadata.format && (
            <div className="flex items-center gap-1">
              <span className="text-[11px] leading-3.5 text-text-tertiary">
                {t('content.format')}
              </span>
              <span className="text-[11px] leading-3.5 text-muted-foreground uppercase">
                {metadata.format}
              </span>
            </div>
          )}
          {metadata.fileSize && (
            <div className="flex items-center gap-1">
              <span className="text-[11px] leading-3.5 text-text-tertiary">
                {t('content.size')}
              </span>
              <span className="text-[11px] leading-3.5 text-muted-foreground">
                {formatFileSize(metadata.fileSize)}
              </span>
            </div>
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
  const { t } = useT('inbox')
  const audioRef = useRef<HTMLAudioElement>(null)
  const waveformRef = useRef<HTMLDivElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [copied, setCopied] = useState(false)
  const [audioError, setAudioError] = useState<string | null>(null)
  const metadata = 'metadata' in item ? (item.metadata as VoiceMetadata | null) : null

  // Stored recording envelope renders instantly (no flat-bar flash); items
  // captured before waveform persistence fall back to decoding the file.
  const storedWaveform = metadata?.waveform
  const [waveformBars, setWaveformBars] = useState<number[]>(() => {
    if (storedWaveform && storedWaveform.length > 0) {
      const maxRms = Math.max(...storedWaveform, 0.001)
      return storedWaveform.map(
        (b) => PLAYBACK_MIN_HEIGHT + (b / maxRms) * (PLAYBACK_MAX_HEIGHT - PLAYBACK_MIN_HEIGHT)
      )
    }
    return Array.from({ length: PLAYBACK_BAR_COUNT }, () => PLAYBACK_MIN_HEIGHT)
  })
  const audioUrl = 'attachmentUrl' in item ? item.attachmentUrl : null
  const transcription = 'transcription' in item ? item.transcription : null
  const transcriptionStatus = 'transcriptionStatus' in item ? item.transcriptionStatus : null

  const displayDuration =
    duration || metadata?.duration || ('duration' in item ? item.duration : 0) || 0

  useEffect(() => {
    if (!audioUrl) return
    // Envelope already persisted at capture time — skip the fetch + decode.
    if (storedWaveform && storedWaveform.length > 0) return

    let cancelled = false
    let activeContext: AudioContext | null = null
    // Browsers cap concurrent AudioContexts, so every exit path has to release
    // this one. close() throws if it runs twice, hence the single-shot guard.
    const releaseContext = (): void => {
      const context = activeContext
      if (!context) return
      activeContext = null
      void context.close()
    }

    const decodeWaveform = async (): Promise<void> => {
      try {
        const response = await fetch(audioUrl)
        const arrayBuffer = await response.arrayBuffer()
        if (cancelled) return

        const audioContext = new AudioContext()
        activeContext = audioContext
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)

        if (cancelled) return

        const rawData = audioBuffer.getChannelData(0)
        const samplesPerBar = Math.floor(rawData.length / PLAYBACK_BAR_COUNT)

        const bars: number[] = []
        for (let i = 0; i < PLAYBACK_BAR_COUNT; i++) {
          let sum = 0
          const start = i * samplesPerBar
          const end = Math.min(start + samplesPerBar, rawData.length)
          for (let j = start; j < end; j++) {
            sum += rawData[j] * rawData[j]
          }
          bars.push(Math.sqrt(sum / samplesPerBar))
        }

        const maxRms = Math.max(...bars, 0.001)
        const normalized = bars.map(
          (b) => PLAYBACK_MIN_HEIGHT + (b / maxRms) * (PLAYBACK_MAX_HEIGHT - PLAYBACK_MIN_HEIGHT)
        )

        setWaveformBars(normalized)
      } catch (err) {
        // A cancelled decode rejects because we closed its context on unmount.
        if (!cancelled) log.error('Failed to decode waveform', err)
      } finally {
        releaseContext()
      }
    }

    void decodeWaveform()
    return () => {
      cancelled = true
      releaseContext()
    }
  }, [audioUrl, storedWaveform])

  const handlePlayPause = async (): Promise<void> => {
    if (!audioRef.current) return
    setAudioError(null)

    if (isPlaying) {
      audioRef.current.pause()
    } else {
      try {
        await audioRef.current.play()
      } catch (err) {
        log.error('Play error', err)
        setAudioError(extractErrorMessage(err, t('content.failedPlayAudio')))
      }
    }
  }

  const handleAudioError = (e: React.SyntheticEvent<HTMLAudioElement>): void => {
    const audio = e.currentTarget
    const error = audio.error
    log.error('Audio error', error?.code, error?.message)
    setAudioError(error?.message || t('content.failedLoadAudio'))
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

  const handleWaveformClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!audioRef.current || !waveformRef.current || !displayDuration) return
      const rect = waveformRef.current.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      const seekTime = ratio * displayDuration
      audioRef.current.currentTime = seekTime
      setCurrentTime(seekTime)
    },
    [displayDuration]
  )

  const handleCopyTranscription = async (): Promise<void> => {
    if (transcription) {
      await navigator.clipboard.writeText(transcription)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const progress = displayDuration > 0 ? currentTime / displayDuration : 0

  const metaParts: string[] = []
  if (metadata?.format) metaParts.push(metadata.format.toUpperCase())
  if (metadata?.sampleRate) metaParts.push(`${(metadata.sampleRate / 1000).toFixed(0)}kHz`)
  if (metadata?.fileSize) metaParts.push(formatFileSize(metadata.fileSize))

  return (
    <div className="flex flex-col gap-4">
      <audio
        ref={audioRef}
        src={audioUrl ?? undefined}
        preload="metadata"
        aria-label={t('content.voiceMemo')}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onError={handleAudioError}
      >
        <track kind="captions" />
      </audio>

      {audioError && (
        <div className="flex items-center gap-2 p-3 bg-destructive/10 rounded-md text-sm text-destructive">
          <AlertCircle className="size-4 shrink-0" />
          <span>{audioError}</span>
        </div>
      )}

      {audioUrl ? (
        <div className="flex items-center rounded-[10px] gap-2.5 bg-muted-foreground/[0.04] border border-muted-foreground/10 py-2.5 px-3.5">
          <button
            type="button"
            onClick={() => void handlePlayPause()}
            className="flex items-center justify-center rounded-full bg-muted-foreground shrink-0 size-8 hover:opacity-90 transition-[opacity,transform] duration-150 ease-out active:scale-90"
            aria-label={isPlaying ? t('content.pause') : t('content.play')}
          >
            {isPlaying ? (
              <Pause className="size-3.5 text-background" />
            ) : (
              <Play className="size-3.5 text-background ms-0.5" />
            )}
          </button>

          <div
            ref={waveformRef}
            className="flex items-center grow h-8 gap-0.5 cursor-pointer"
            onClick={handleWaveformClick}
            role="slider"
            aria-label={t('content.audioPosition')}
            aria-valuemin={0}
            aria-valuemax={displayDuration || 100}
            aria-valuenow={currentTime}
            tabIndex={0}
          >
            {waveformBars.map((height, i) => {
              const isPlayed = i / PLAYBACK_BAR_COUNT < progress
              return (
                <div
                  key={i}
                  className="flex-1 min-w-0 rounded-xs transition-colors duration-150"
                  style={{
                    height: `${height}px`,
                    backgroundColor: isPlayed
                      ? 'color-mix(in srgb, var(--muted-foreground) 80%, transparent)'
                      : 'color-mix(in srgb, var(--muted-foreground) 30%, transparent)'
                  }}
                />
              )
            })}
          </div>

          <div className="flex items-center shrink-0 gap-0.5 text-xs tabular-nums">
            <span className="text-foreground font-medium">{formatDuration(currentTime)}</span>
            <span className="text-text-tertiary">/ {formatDuration(displayDuration)}</span>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3 p-3.5 bg-muted rounded-[10px]">
          <div className="size-8 rounded-full bg-muted-foreground flex items-center justify-center">
            <Mic className="size-4 text-background" />
          </div>
          <div className="flex-1">
            <p className="font-medium text-sm">{item.title}</p>
            <p className="text-xs text-muted-foreground">
              {displayDuration > 0 ? formatDuration(displayDuration) : t('content.voiceMemo')}
            </p>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <span className="uppercase tracking-[0.04em] text-text-tertiary font-medium text-[11px]/3.5">
            {t('content.transcription')}
          </span>
          {transcriptionStatus === 'processing' && (
            <div className="flex items-center gap-1 rounded-[10px] py-px px-1.5 bg-muted-foreground/10">
              <Loader2 className="size-2.5 animate-spin text-muted-foreground" />
              <span className="text-muted-foreground text-[10px]/3.5">
                {t('content.processing')}
              </span>
            </div>
          )}
          {transcriptionStatus === 'pending' && (
            <div className="flex items-center rounded-[10px] py-px px-1.5 bg-muted-foreground/10">
              <span className="text-muted-foreground text-[10px]/3.5">{t('content.pending')}</span>
            </div>
          )}
          {transcriptionStatus === 'failed' && (
            <div className="flex items-center rounded-[10px] py-px px-1.5 bg-destructive/10">
              <span className="text-destructive text-[10px]/3.5">{t('content.failed')}</span>
            </div>
          )}
          {transcription && (
            <button
              type="button"
              onClick={() => void handleCopyTranscription()}
              className="ms-auto text-muted-foreground hover:text-foreground transition-all duration-150 ease-out active:scale-90"
              aria-label={t('content.copyTranscription')}
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </button>
          )}
        </div>

        {transcription ? (
          <p className="text-muted-foreground text-xs/[18px]">{transcription}</p>
        ) : transcriptionStatus === 'processing' || transcriptionStatus === 'pending' ? (
          <p className="text-muted-foreground text-xs italic">
            {transcriptionStatus === 'processing'
              ? t('content.transcribingAudio')
              : t('content.awaitingTranscription')}
          </p>
        ) : transcriptionStatus === 'failed' ? (
          <div className="flex items-center gap-2">
            <span className="text-destructive text-xs">{t('list.transcriptionFailed')}</span>
            {onRetryTranscription && (
              <button
                type="button"
                onClick={onRetryTranscription}
                disabled={isRetrying}
                className="text-muted-foreground hover:text-foreground text-xs flex items-center gap-1 transition-all duration-150 ease-out active:scale-95 disabled:opacity-50 disabled:active:scale-100"
              >
                {isRetrying ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <RefreshCw className="size-3" />
                )}
                {t('list.retryTranscription')}
              </button>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs italic">{t('content.noTranscription')}</p>
        )}
      </div>

      {metaParts.length > 0 && (
        <div className="text-text-tertiary text-[11px]/3.5">{metaParts.join(' · ')}</div>
      )}
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
  const { t } = useT('inbox')
  const metadata = 'metadata' in item ? (item.metadata as PdfMetadata | null) : null

  const metaParts: string[] = []
  if (metadata?.pageCount) metaParts.push(t('list.pageCount', { count: metadata.pageCount }))
  if (metadata?.fileSize) metaParts.push(formatFileSize(metadata.fileSize))

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-col items-center justify-center gap-2.5 aspect-[34/18] rounded-lg bg-muted border border-border">
        <FilePdf className="size-9 text-destructive" />
        {metaParts.length > 0 && (
          <span className="text-[11px] leading-3.5 text-text-tertiary">
            {metaParts.join(' · ')}
          </span>
        )}
      </div>

      {metadata?.originalFilename && (
        <span
          className="text-[11px] leading-3.5 text-muted-foreground truncate"
          title={metadata.originalFilename}
        >
          {metadata.originalFilename}
        </span>
      )}
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
  const { t } = useT('inbox')
  const videoUrl = 'attachmentUrl' in item ? item.attachmentUrl : null
  const metadata = 'metadata' in item ? (item.metadata as Record<string, unknown> | null) : null

  return (
    <div className="space-y-4">
      {videoUrl ? (
        <div className="relative overflow-hidden rounded-md bg-black">
          <video src={videoUrl} controls className="w-full max-h-[400px]" preload="metadata">
            <track kind="captions" />
            {t('content.unsupportedVideo')}
          </video>
        </div>
      ) : (
        <div className="flex items-center justify-center h-[200px] bg-[var(--muted)] rounded-md">
          <FileText className="size-12 text-[var(--muted-foreground)]" />
        </div>
      )}

      {/* Video metadata */}
      {(() => {
        const fileSize = metadata?.fileSize
        const originalFilename = metadata?.originalFilename
        return (
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-[var(--muted-foreground)] px-1">
            <span className="uppercase font-medium">{t('content.video')}</span>
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
  const { t } = useT('inbox')

  return (
    <InboxContentEditor
      initialContent={item.content}
      onContentChange={onContentChange}
      editable={true}
      placeholder={t('detail.textPlaceholder')}
    />
  )
}

// =============================================================================
// Link Article Content (clickable source + editable extracted article)
// =============================================================================

interface LinkArticleProps {
  item: ContentItem
  onContentChange?: (content: string) => void
}

const LinkArticle = ({ item, onContentChange }: LinkArticleProps): React.JSX.Element => (
  <div className="flex flex-col gap-2.5">
    {item.sourceUrl && (
      <a
        href={item.sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 text-sm text-[var(--primary)] hover:underline"
      >
        <Globe className="size-4 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
        <span className="truncate">{extractDomain(item.sourceUrl)}</span>
      </a>
    )}
    <SimpleContent item={item} onContentChange={onContentChange} />
  </div>
)

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
    case 'link': {
      // YouTube keeps its inline player; screenshot captures stay an image preview.
      // Everything else is an extracted article → full, editable body.
      // ponytail: screenshot detected by the exact marker ingest writes (`![screenshot](…)`).
      const isScreenshot = (item.content ?? '').trim().startsWith('![screenshot]')
      const isYouTube = item.sourceUrl ? extractYouTubeVideoId(item.sourceUrl) !== null : false
      if (isYouTube || isScreenshot) return <LinkPreview item={item} />
      return <LinkArticle item={item} onContentChange={onContentChange} />
    }
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
    case 'social':
      return <TweetCard item={item as Parameters<typeof TweetCard>[0]['item']} />
    case 'reminder':
      return <ReminderDetail item={item} />
    case 'clip':
    default:
      return <SimpleContent item={item} onContentChange={onContentChange} />
  }
}
