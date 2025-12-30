/**
 * Capture Input Component
 *
 * A refined input for quickly capturing text notes, links, and voice memos to the inbox.
 * Auto-detects URLs vs plain text and uses the appropriate capture method.
 * Includes voice recording with automatic transcription.
 * Matches the contemplative editorial design of the Journal page.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { Send, Loader2, Link, FileText, Mic } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCaptureText, useCaptureLink, useCaptureVoice } from '@/hooks/use-inbox'
import { type DisplayDensity, DENSITY_CONFIG } from '@/hooks/use-display-density'
import { VoiceRecorder } from './voice-recorder'

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

  // Get density-specific config
  const densityConfig = DENSITY_CONFIG[density]

  const captureText = useCaptureText()
  const captureLink = useCaptureLink()
  const captureVoice = useCaptureVoice()

  const isCapturing = captureText.isPending || captureLink.isPending || captureVoice.isPending
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
        handleSubmit()
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

  /**
   * Start voice recording
   */
  const handleMicClick = useCallback(() => {
    setIsRecording(true)
  }, [])

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
          'relative flex items-start',
          densityConfig.captureGap,
          densityConfig.capturePadding,
          'bg-muted/20 hover:bg-muted/30',
          'border border-border/40',
          densityConfig.captureRadius,
          'transition-all duration-200',
          isFocused && 'bg-muted/40 border-border/60 shadow-sm'
        )}
      >
        {/* Type indicator icon */}
        <div
          className={cn(
            'mt-1 flex-shrink-0',
            'text-muted-foreground/50',
            'transition-colors duration-200',
            isFocused && 'text-muted-foreground/70'
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
          placeholder="Capture a thought or paste a link..."
          disabled={isCapturing}
          rows={1}
          className={cn(
            'flex-1 min-h-[24px] max-h-[200px]',
            'bg-transparent',
            'text-sm text-foreground/90',
            'placeholder:text-muted-foreground/50',
            'resize-none',
            'focus:outline-none',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            'font-serif tracking-wide'
          )}
          aria-label="Capture input"
        />

        {/* Microphone button for voice recording */}
        <button
          onClick={handleMicClick}
          disabled={isCapturing}
          className={cn(
            'mt-0.5 flex-shrink-0',
            'p-1.5 rounded-lg',
            'text-muted-foreground/50',
            'transition-all duration-200',
            'hover:bg-foreground/5 hover:text-foreground/70',
            'disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent'
          )}
          aria-label="Record voice memo"
          title="Record voice memo"
        >
          <Mic className="size-4" aria-hidden="true" />
        </button>

        {/* Submit button */}
        <button
          onClick={handleSubmit}
          disabled={!value.trim() || isCapturing}
          className={cn(
            'mt-0.5 flex-shrink-0',
            'p-1.5 rounded-lg',
            'text-muted-foreground/50',
            'transition-all duration-200',
            'hover:bg-foreground/5 hover:text-foreground/70',
            'disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent',
            value.trim() && !isCapturing && 'text-amber-600 dark:text-amber-400'
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
          'mt-1.5 px-4',
          'text-xs text-muted-foreground/40',
          'transition-opacity duration-200',
          !isFocused && 'opacity-0'
        )}
      >
        {isUrl ? (
          <span>
            Press <kbd className="px-1 py-0.5 bg-muted/50 rounded text-[10px]">Enter</kbd> to
            capture link
          </span>
        ) : (
          <span>
            Press <kbd className="px-1 py-0.5 bg-muted/50 rounded text-[10px]">Enter</kbd> to
            capture, <kbd className="px-1 py-0.5 bg-muted/50 rounded text-[10px]">Shift+Enter</kbd>{' '}
            for new line
          </span>
        )}
      </div>
    </div>
  )
}
