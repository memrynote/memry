/**
 * Capture Input Component
 *
 * A refined input for quickly capturing text notes, links, and voice memos to the inbox.
 * Auto-detects URLs vs plain text and uses the appropriate capture method.
 * Includes voice recording with automatic transcription.
 * Matches the contemplative editorial design of the Journal page.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { Send, Loader2, Link, FileText, Mic, Paperclip } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCaptureText, useCaptureLink, useCaptureVoice, useCaptureImage } from '@/hooks/use-inbox'
import { type DisplayDensity, DENSITY_CONFIG } from '@/hooks/use-display-density'
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
  className
}: CaptureInputProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const [isFocused, setIsFocused] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const densityConfig = DENSITY_CONFIG[density]

  const captureText = useCaptureText()
  const captureLink = useCaptureLink()
  const captureVoice = useCaptureVoice()
  const captureImage = useCaptureImage()

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

  const handleSubmit = useCallback(async () => {
    const trimmed = value.trim()
    if (!trimmed || isCapturing) return

    try {
      if (isLikelyUrl(trimmed)) {
        // Capture as link
        const url = normalizeUrl(trimmed)
        const result = await captureLink.mutateAsync({ url })
        if (result.success) {
          setValue('')
          onCaptureSuccess?.()
        } else {
          onCaptureError?.(result.error || 'Failed to capture link')
        }
      } else {
        // Capture as text note
        // Use first line as title if multi-line, otherwise use content
        const lines = trimmed.split('\n')
        const title = lines.length > 1 ? lines[0].slice(0, 100) : trimmed.slice(0, 100)

        const result = await captureText.mutateAsync({
          content: trimmed,
          title: title + (title.length < trimmed.length ? '...' : '')
        })
        if (result.success) {
          setValue('')
          onCaptureSuccess?.()
        } else {
          onCaptureError?.(result.error || 'Failed to capture note')
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Capture failed'
      onCaptureError?.(message)
    }
  }, [value, isCapturing, captureText, captureLink, onCaptureSuccess, onCaptureError])

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
        // Convert Blob to ArrayBuffer
        const arrayBuffer = await audioBlob.arrayBuffer()

        // Capture voice memo
        const result = await captureVoice.mutateAsync({
          data: arrayBuffer,
          duration,
          format: 'webm',
          transcribe: true
        })

        if (result.success) {
          onCaptureSuccess?.()
        } else {
          onCaptureError?.(result.error || 'Failed to capture voice memo')
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Voice capture failed'
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

  const handleMicClick = useCallback(() => {
    setIsRecording(true)
  }, [])

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
          mimeType: file.type
        })

        if (result.success) {
          onCaptureSuccess?.()
        } else {
          onCaptureError?.(result.error || 'Failed to capture file')
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'File capture failed'
        onCaptureError?.(message)
      }
    },
    [captureImage, onCaptureSuccess, onCaptureError]
  )

  // Show voice recorder when recording
  if (isRecording) {
    return (
      <div className={cn('relative group', 'transition-all duration-300', className)}>
        <VoiceRecorder
          onRecordingComplete={handleRecordingComplete}
          onCancel={handleRecordingCancel}
          maxDuration={300}
          className="w-full"
        />
      </div>
    )
  }

  return (
    <div className={cn('relative group', 'transition-all duration-300', className)}>
      {/* Input container with editorial styling */}
      <div
        className={cn(
          'relative flex items-center',
          densityConfig.captureGap,
          densityConfig.capturePadding,
          // Enhanced foundation - soft gradient with depth
          'bg-linear-to-r from-muted/30 via-muted/40 to-muted/30',
          'hover:from-muted/35 hover:via-muted/45 hover:to-muted/35',
          'border border-border/60',
          'shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)]',
          densityConfig.captureRadius,
          'transition-all duration-300',
          // Focused state with warm amber glow
          isFocused && 'bg-muted/50 border-border shadow-sm ring-1 ring-amber-500/20'
        )}
      >
        {/* Type indicator icon */}
        <div
          className={cn(
            'shrink-0',
            'text-muted-foreground/70', // More visible
            'transition-colors duration-200',
            isFocused && 'text-amber-600 dark:text-amber-400' // Amber on focus
          )}
        >
          {isUrl ? (
            <Link className="size-4" aria-hidden="true" />
          ) : (
            <FileText className="size-4" aria-hidden="true" />
          )}
        </div>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          onKeyDown={handleKeyDown}
          placeholder="What's on your mind?"
          disabled={isCapturing}
          rows={1}
          className={cn(
            'flex-1 min-h-[24px] max-h-[200px]',
            'bg-transparent',
            'text-sm text-foreground/90 leading-6',
            // Editorial placeholder - serif, italic, more visible
            'placeholder:font-serif placeholder:italic',
            'placeholder:text-muted-foreground/60',
            'resize-none',
            'focus:outline-none',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            'tracking-wide'
          )}
          aria-label="Capture input"
        />

        {/* Attachment button */}
        <button
          onClick={handleAttachClick}
          disabled={isCapturing}
          className={cn(
            'shrink-0',
            'p-1.5 rounded-lg',
            'text-muted-foreground/60', // More visible
            'transition-all duration-200',
            'hover:bg-amber-500/10 hover:text-amber-600 dark:hover:text-amber-400', // Amber hover
            'disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent'
          )}
          aria-label="Attach file"
          title="Attach file (Images, Audio, Video, PDF)"
        >
          <Paperclip className="size-4" aria-hidden="true" />
        </button>

        {/* Microphone button */}
        <button
          onClick={handleMicClick}
          disabled={isCapturing}
          className={cn(
            'shrink-0',
            'p-1.5 rounded-lg',
            'text-muted-foreground/60', // More visible
            'transition-all duration-200',
            'hover:bg-amber-500/10 hover:text-amber-600 dark:hover:text-amber-400', // Amber hover
            'disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent'
          )}
          aria-label="Record voice memo"
          title="Record voice memo"
        >
          <Mic className="size-4" aria-hidden="true" />
        </button>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept={ALLOWED_ATTACHMENT_TYPES.join(',')}
          onChange={handleFileSelect}
          className="hidden"
          aria-hidden="true"
        />

        {/* Submit button */}
        <button
          onClick={handleSubmit}
          disabled={!value.trim() || isCapturing}
          className={cn(
            'shrink-0',
            'p-1.5 rounded-lg',
            'text-muted-foreground/60', // More visible
            'transition-all duration-200',
            'hover:bg-amber-500/10 hover:text-amber-600 dark:hover:text-amber-400', // Amber hover
            'disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent',
            // Active state when there's content
            value.trim() && !isCapturing && 'text-amber-600 dark:text-amber-400 bg-amber-500/10'
          )}
          aria-label={isUrl ? 'Capture link' : 'Capture note'}
        >
          {isCapturing ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Send className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>

      {/* Hint text */}
      <div
        className={cn(
          'mt-2 px-4',
          'text-xs text-muted-foreground/60', // More visible
          'transition-all duration-200',
          !isFocused && 'opacity-0 translate-y-1',
          isFocused && 'opacity-100 translate-y-0'
        )}
      >
        {isUrl ? (
          <span>
            Press{' '}
            <kbd className="px-1.5 py-0.5 bg-muted/70 rounded border border-border/50 text-[10px] font-medium">
              Enter
            </kbd>{' '}
            to capture link
          </span>
        ) : (
          <span>
            Press{' '}
            <kbd className="px-1.5 py-0.5 bg-muted/70 rounded border border-border/50 text-[10px] font-medium">
              Enter
            </kbd>{' '}
            to capture,{' '}
            <kbd className="px-1.5 py-0.5 bg-muted/70 rounded border border-border/50 text-[10px] font-medium">
              Shift+Enter
            </kbd>{' '}
            for new line
          </span>
        )}
      </div>
    </div>
  )
}
