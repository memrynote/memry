/**
 * Capture Input Component
 *
 * A refined input for quickly capturing text notes, links, and voice memos to the inbox.
 * Auto-detects URLs vs plain text and uses the appropriate capture method.
 * Includes voice recording with automatic transcription.
 * Matches the contemplative editorial design of the Journal page.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { Send, Loader2, Link, FileText, Mic, Paperclip, Copy } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useCaptureText, useCaptureLink, useCaptureVoice, useCaptureImage } from '@/hooks/use-inbox'
import type { DisplayDensity } from '@/hooks/use-display-density'
import { useSettingsModal } from '@/contexts/settings-modal-context'
import { ensureVoiceRecordingReady } from '@/lib/voice-recording-readiness'
import { prepareVoiceMemoAudio } from '@/lib/voice-memo-audio'
import { VoiceRecorder } from './voice-recorder'

/**
 * All allowed attachment MIME types for inbox capture.
 * Matches the viewable file types in the application.
 */
const ALLOWED_ATTACHMENT_TYPES = [
  // Images
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  // Audio
  'audio/mpeg', // mp3
  'audio/mp3',
  'audio/wav',
  'audio/ogg',
  'audio/mp4', // m4a
  'audio/x-m4a',
  'audio/flac',
  'audio/aac',
  'audio/webm',
  // Video
  'video/mp4',
  'video/webm',
  'video/quicktime', // mov
  'video/x-msvideo', // avi
  'video/x-matroska', // mkv
  // Documents
  'application/pdf'
] as const

type AllowedAttachmentType = (typeof ALLOWED_ATTACHMENT_TYPES)[number]

interface CaptureInputProps {
  onCaptureSuccess?: () => void
  onCaptureError?: (error: string) => void
  density?: DisplayDensity
  compact?: boolean
  className?: string
}

/**
 * Simple URL detection regex
 * Matches common URL patterns including http(s), www, and common TLDs
 */
const URL_REGEX =
  /^(https?:\/\/|www\.)[^\s]+$|^[^\s]+\.(com|org|net|io|co|dev|app|me|info|biz|edu|gov)[^\s]*$/i

/**
 * Check if a string looks like a URL
 */
function isLikelyUrl(text: string): boolean {
  const trimmed = text.trim()
  // Don't match if it's multi-line (notes can contain URLs)
  if (trimmed.includes('\n')) return false
  return URL_REGEX.test(trimmed)
}

/**
 * Normalize a URL by adding https:// if missing
 */
function normalizeUrl(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed
  }
  if (trimmed.startsWith('www.')) {
    return `https://${trimmed}`
  }
  // For bare domains like "example.com/path"
  return `https://${trimmed}`
}

export function CaptureInput({
  onCaptureSuccess,
  onCaptureError,
  density = 'comfortable',
  compact = false,
  className
}: CaptureInputProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const [isFocused, setIsFocused] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [duplicateMatch, setDuplicateMatch] = useState<{
    id: string
    title: string
    createdAt: string
  } | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const captureText = useCaptureText()
  const captureLink = useCaptureLink()
  const captureVoice = useCaptureVoice()
  const captureImage = useCaptureImage()
  const { open: openSettings } = useSettingsModal()

  const isCapturing =
    captureText.isPending ||
    captureLink.isPending ||
    captureVoice.isPending ||
    captureImage.isPending
  const isUrl = isLikelyUrl(value)

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
    }
  }, [value])

  const handleSubmit = useCallback(
    async (force = false) => {
      const trimmed = value.trim()
      if (!trimmed || isCapturing) return

      setDuplicateMatch(null)

      try {
        if (isLikelyUrl(trimmed)) {
          const url = normalizeUrl(trimmed)
          const result = await captureLink.mutateAsync({ url, force, source: 'inline' })
          if (result.duplicate && result.existingItem) {
            setDuplicateMatch(result.existingItem)
            return
          }
          if (result.success) {
            setValue('')
            onCaptureSuccess?.()
          } else {
            onCaptureError?.(extractErrorMessage(result.error, 'Failed to capture link'))
          }
        } else {
          const lines = trimmed.split('\n')
          const title = lines.length > 1 ? lines[0].slice(0, 100) : trimmed.slice(0, 100)

          const result = await captureText.mutateAsync({
            content: trimmed,
            title: title + (title.length < trimmed.length ? '...' : ''),
            force,
            source: 'inline'
          })
          if (result.duplicate && result.existingItem) {
            setDuplicateMatch(result.existingItem)
            return
          }
          if (result.success) {
            setValue('')
            onCaptureSuccess?.()
          } else {
            onCaptureError?.(extractErrorMessage(result.error, 'Failed to capture note'))
          }
        }
      } catch (err) {
        const message = extractErrorMessage(err, 'Capture failed')
        onCaptureError?.(message)
      }
    },
    [value, isCapturing, captureText, captureLink, onCaptureSuccess, onCaptureError]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Enter to submit (unless Shift is held for multi-line)
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void handleSubmit()
      }
    },
    [handleSubmit]
  )

  /**
   * Handle voice recording completion
   */
  const handleRecordingComplete = useCallback(
    async (audioBlob: Blob, duration: number) => {
      setIsRecording(false)

      try {
        const preparedAudio = await prepareVoiceMemoAudio(audioBlob)

        // Capture voice memo
        const result = await captureVoice.mutateAsync({
          data: preparedAudio.data,
          duration: duration || preparedAudio.duration,
          format: preparedAudio.format,
          transcribe: true,
          source: 'inline'
        })

        if (result.success) {
          onCaptureSuccess?.()
        } else {
          onCaptureError?.(extractErrorMessage(result.error, 'Failed to capture voice memo'))
        }
      } catch (err) {
        const message = extractErrorMessage(err, 'Voice capture failed')
        onCaptureError?.(message)
      }
    },
    [captureVoice, onCaptureSuccess, onCaptureError]
  )

  /**
   * Handle voice recording cancellation
   */
  const handleRecordingCancel = useCallback(() => {
    setIsRecording(false)
  }, [])

  const handleMicClick = useCallback(async () => {
    const ready = await ensureVoiceRecordingReady(() => {
      openSettings('ai')
    })

    if (ready) {
      setIsRecording(true)
    }
  }, [openSettings])

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return

      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }

      if (!ALLOWED_ATTACHMENT_TYPES.includes(file.type as AllowedAttachmentType)) {
        onCaptureError?.(`Unsupported file type: ${file.type}`)
        return
      }

      try {
        const arrayBuffer = await file.arrayBuffer()
        const result = await captureImage.mutateAsync({
          data: arrayBuffer,
          filename: file.name,
          mimeType: file.type,
          source: 'inline'
        })

        if (result.success) {
          onCaptureSuccess?.()
        } else {
          onCaptureError?.(extractErrorMessage(result.error, 'Failed to capture file'))
        }
      } catch (err) {
        const message = extractErrorMessage(err, 'File capture failed')
        onCaptureError?.(message)
      }
    },
    [captureImage, onCaptureSuccess, onCaptureError]
  )

  return (
    <div
      className={cn(
        'relative group flex flex-col gap-2',
        compact && 'grow shrink basis-0 min-w-0',
        'transition-all duration-300',
        className
      )}
    >
      <div
        className={cn(
          'relative flex items-center',
          compact ? 'gap-1.5 px-2.5 py-1 rounded-md' : 'gap-2.5 px-3.5 py-2.5 rounded-[10px]',
          'border-[1.5px] border-dashed transition-all duration-150',
          !isFocused &&
            (compact ? 'border-border hover:border-text-tertiary' : 'border-border/30 bg-muted/20'),
          isFocused &&
            (compact
              ? 'border-amber-500/60 bg-muted/10'
              : 'bg-muted/30 border-border/50 ring-1 ring-amber-500/20')
        )}
      >
        <div
          className={cn(
            'shrink-0 text-muted-foreground/50 transition-colors duration-200',
            isFocused && 'text-amber-600 dark:text-amber-400'
          )}
        >
          {isUrl ? (
            <Link className={compact ? 'size-3.5' : 'size-4'} aria-hidden="true" />
          ) : (
            <FileText className={compact ? 'size-3.5' : 'size-4'} aria-hidden="true" />
          )}
        </div>

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            if (duplicateMatch) setDuplicateMatch(null)
          }}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          onKeyDown={handleKeyDown}
          placeholder={
            compact
              ? 'Capture a link or thought...'
              : 'Quick capture — paste a link, jot a thought...'
          }
          disabled={isCapturing}
          rows={1}
          className={cn(
            'flex-1 bg-transparent resize-none focus:outline-none',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            compact
              ? 'min-h-[18px] max-h-[18px] text-[12px] leading-[18px] placeholder:text-text-tertiary'
              : 'min-h-[24px] max-h-[200px] text-sm text-foreground/90 leading-6 placeholder:text-muted-foreground/40'
          )}
          aria-label="Capture input"
        />

        <div className={cn('flex shrink-0 items-center', compact ? 'gap-0.5' : 'gap-1')}>
          <button
            onClick={handleAttachClick}
            disabled={isCapturing}
            className={cn(
              'flex items-center justify-center rounded-md',
              'text-muted-foreground/50 transition-colors duration-200',
              'hover:text-muted-foreground',
              'disabled:opacity-30 disabled:cursor-not-allowed',
              compact ? 'size-5' : 'size-7'
            )}
            aria-label="Attach file"
            title="Attach file (Images, Audio, Video, PDF)"
          >
            <Paperclip className={compact ? 'size-3' : 'size-[15px]'} aria-hidden="true" />
          </button>

          <button
            onClick={handleMicClick}
            disabled={isCapturing}
            className={cn(
              'flex items-center justify-center rounded-md',
              'text-muted-foreground/50 transition-colors duration-200',
              'hover:text-muted-foreground',
              'disabled:opacity-30 disabled:cursor-not-allowed',
              compact ? 'size-5' : 'size-7'
            )}
            aria-label="Record voice memo"
            title="Record voice memo"
          >
            <Mic className={compact ? 'size-3' : 'size-[15px]'} aria-hidden="true" />
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept={ALLOWED_ATTACHMENT_TYPES.join(',')}
            onChange={handleFileSelect}
            className="hidden"
            aria-hidden="true"
          />

          <button
            onClick={() => handleSubmit()}
            disabled={!value.trim() || isCapturing}
            className={cn(
              'flex items-center justify-center rounded-md',
              'transition-all duration-200',
              value.trim() && !isCapturing
                ? 'bg-amber-500 text-background dark:text-black'
                : compact
                  ? 'text-muted-foreground/30'
                  : 'bg-muted/40 text-muted-foreground/30',
              'disabled:cursor-not-allowed',
              compact ? 'size-5' : 'size-7'
            )}
            aria-label={isUrl ? 'Capture link' : 'Capture note'}
          >
            {isCapturing ? (
              <Loader2
                className={cn('animate-spin', compact ? 'size-3' : 'size-3.5')}
                aria-hidden="true"
              />
            ) : (
              <Send className={compact ? 'size-3' : 'size-3.5'} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/* Duplicate notice */}
      {duplicateMatch && (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
          <Copy className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="flex-1 text-xs text-muted-foreground">
            Already captured: &ldquo;{duplicateMatch.title.slice(0, 50)}
            {duplicateMatch.title.length > 50 ? '...' : ''}&rdquo;
          </p>
          <button
            onClick={() => handleSubmit(true)}
            className="shrink-0 text-xs font-medium text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
          >
            Capture Anyway
          </button>
        </div>
      )}

      {isRecording && (
        <VoiceRecorder
          onRecordingComplete={handleRecordingComplete}
          onCancel={handleRecordingCancel}
          maxDuration={300}
          autoStart
          className="w-full"
        />
      )}
    </div>
  )
}
