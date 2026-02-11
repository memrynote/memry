/**
 * Quick Capture Component
 *
 * A minimal, focused capture window for the global shortcut (Cmd+Shift+Space).
 * Auto-detects clipboard content and allows quick capture of text or URLs.
 *
 * Features:
 * - Auto-fill from clipboard on mount
 * - URL detection with visual indicator
 * - Enter to submit, Escape to close
 * - 1-second success message before auto-close
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { Send, Loader2, Link, FileText, Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useCaptureText, useCaptureLink } from '@/hooks/use-inbox'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:QuickCapture')

type CaptureState = 'idle' | 'capturing' | 'success' | 'error'

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

export function QuickCapture(): React.JSX.Element {
  const [value, setValue] = useState('')
  const [captureState, setCaptureState] = useState<CaptureState>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const captureText = useCaptureText()
  const captureLink = useCaptureLink()

  const isCapturing = captureState === 'capturing'
  const isUrl = isLikelyUrl(value)

  // Auto-focus and load clipboard on mount
  useEffect(() => {
    const loadClipboard = async (): Promise<void> => {
      try {
        const clipboardText = await window.api.quickCapture.getClipboard()
        // Only pre-fill if clipboard has meaningful content
        // Skip if it looks like an error message or stack trace
        if (
          clipboardText &&
          clipboardText.trim() &&
          !clipboardText.includes('Error:') &&
          !clipboardText.includes('at ') &&
          clipboardText.length < 5000
        ) {
          setValue(clipboardText.trim())
        }
      } catch (err) {
        log.warn('Failed to read clipboard', err)
      }

      // Focus the textarea after clipboard is loaded
      textareaRef.current?.focus()
      // Select all text for easy replacement
      textareaRef.current?.select()
    }

    loadClipboard()
  }, [])

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`
    }
  }, [value])

  // Close window after success
  useEffect(() => {
    if (captureState === 'success') {
      const timer = setTimeout(() => {
        window.api.quickCapture.close()
      }, 1000)
      return (): void => {
        clearTimeout(timer)
      }
    }
    return undefined
  }, [captureState])

  const handleSubmit = useCallback(async () => {
    const trimmed = value.trim()
    if (!trimmed || isCapturing) return

    setCaptureState('capturing')
    setErrorMessage('')

    try {
      if (isLikelyUrl(trimmed)) {
        // Capture as link
        const url = normalizeUrl(trimmed)
        const result = await captureLink.mutateAsync({ url })
        if (result.success) {
          setCaptureState('success')
        } else {
          setErrorMessage(extractErrorMessage(result.error, 'Failed to capture link'))
          setCaptureState('error')
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
          setCaptureState('success')
        } else {
          setErrorMessage(extractErrorMessage(result.error, 'Failed to capture note'))
          setCaptureState('error')
        }
      }
    } catch (err) {
      const message = extractErrorMessage(err, 'Capture failed')
      setErrorMessage(message)
      setCaptureState('error')
    }
  }, [value, isCapturing, captureText, captureLink])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Escape to close
      if (e.key === 'Escape') {
        e.preventDefault()
        window.api.quickCapture.close()
        return
      }

      // Enter to submit (unless Shift is held for multi-line)
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  // Global escape handler (in case textarea isn't focused)
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        window.api.quickCapture.close()
      }
    }

    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [])

  // Success state
  if (captureState === 'success') {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-background p-4">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex items-center justify-center size-12 rounded-full bg-green-100 dark:bg-green-900/30">
            <Check className="size-6 text-green-600 dark:text-green-400" />
          </div>
          <p className="text-sm font-medium text-foreground">Captured!</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-background p-4">
      {/* Header with drag region */}
      <div className="drag-region flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="size-3 rounded-full bg-red-500" />
          <div className="size-3 rounded-full bg-yellow-500" />
          <div className="size-3 rounded-full bg-green-500" />
        </div>
        <span className="text-xs text-muted-foreground">Quick Capture</span>
        <button
          onClick={() => window.api.quickCapture.close()}
          className="p-1 rounded hover:bg-muted/50 text-muted-foreground"
          aria-label="Close"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Input area */}
      <div className="flex-1 flex flex-col min-h-0">
        <div
          className={cn(
            'relative flex items-start gap-3',
            'px-3 py-2.5',
            'bg-muted/30',
            'border border-border/50',
            'rounded-lg',
            'transition-all duration-200',
            'focus-within:bg-muted/50 focus-within:border-border'
          )}
        >
          {/* Type indicator icon */}
          <div className="mt-0.5 flex-shrink-0 text-muted-foreground/60">
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
            onChange={(e) => {
              setValue(e.target.value)
              if (captureState === 'error') {
                setCaptureState('idle')
                setErrorMessage('')
              }
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a note or paste a link..."
            disabled={isCapturing}
            rows={1}
            className={cn(
              'flex-1 min-h-[24px] max-h-[120px]',
              'bg-transparent',
              'text-sm text-foreground',
              'placeholder:text-muted-foreground/50',
              'resize-none',
              'focus:outline-none',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
            aria-label="Quick capture input"
          />

          {/* Submit button */}
          <button
            onClick={handleSubmit}
            disabled={!value.trim() || isCapturing}
            className={cn(
              'mt-0.5 flex-shrink-0',
              'p-1.5 rounded-md',
              'text-muted-foreground/50',
              'transition-all duration-200',
              'hover:bg-foreground/5 hover:text-foreground/70',
              'disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent',
              value.trim() && !isCapturing && 'text-primary'
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

        {/* Error message */}
        {captureState === 'error' && errorMessage && (
          <p className="mt-2 text-xs text-red-500 px-1">{errorMessage}</p>
        )}

        {/* Hint text */}
        <div className="mt-2 px-1 text-xs text-muted-foreground/50">
          {isUrl ? (
            <span>
              Press <kbd className="px-1 py-0.5 bg-muted/50 rounded text-[10px]">Enter</kbd> to
              capture link
            </span>
          ) : (
            <span>
              <kbd className="px-1 py-0.5 bg-muted/50 rounded text-[10px]">Enter</kbd> to capture,{' '}
              <kbd className="px-1 py-0.5 bg-muted/50 rounded text-[10px]">Shift+Enter</kbd> for new
              line, <kbd className="px-1 py-0.5 bg-muted/50 rounded text-[10px]">Esc</kbd> to close
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export default QuickCapture
