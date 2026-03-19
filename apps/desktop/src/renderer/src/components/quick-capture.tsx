import { useState, useCallback, useRef, useEffect } from 'react'
import { Send, Loader2, Link, FileText, Check, X, Image, Mic, FileIcon, Copy } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useCaptureText, useCaptureLink, useCaptureImage, useCaptureVoice } from '@/hooks/use-inbox'
import { VoiceRecorder } from './voice-recorder'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:QuickCapture')

type CaptureState = 'idle' | 'capturing' | 'success' | 'error' | 'duplicate'
type DetectedType = 'note' | 'link' | 'image' | 'voice' | 'pdf'

const URL_REGEX =
  /^(https?:\/\/|www\.)[^\s]+$|^[^\s]+\.(com|org|net|io|co|dev|app|me|info|biz|edu|gov)[^\s]*$/i

function isLikelyUrl(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.includes('\n')) return false
  return URL_REGEX.test(trimmed)
}

function normalizeUrl(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
  if (trimmed.startsWith('www.')) return `https://${trimmed}`
  return `https://${trimmed}`
}

const TYPE_ICONS: Record<DetectedType, typeof FileText> = {
  note: FileText,
  link: Link,
  image: Image,
  voice: Mic,
  pdf: FileIcon
}

const DROPPABLE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
  'application/pdf'
])

export function QuickCapture(): React.JSX.Element {
  const [value, setValue] = useState('')
  const [captureState, setCaptureState] = useState<CaptureState>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [detectedType, setDetectedType] = useState<DetectedType>('note')
  const [clipboardImage, setClipboardImage] = useState<Blob | null>(null)
  const [clipboardImageUrl, setClipboardImageUrl] = useState<string | null>(null)
  const [droppedFile, setDroppedFile] = useState<File | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [duplicateMatch, setDuplicateMatch] = useState<{
    id: string
    title: string
    createdAt: string
  } | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const captureText = useCaptureText()
  const captureLink = useCaptureLink()
  const captureImage = useCaptureImage()
  const captureVoice = useCaptureVoice()

  const isCapturing = captureState === 'capturing'

  // Detect type from current input state
  useEffect(() => {
    if (clipboardImage || droppedFile?.type.startsWith('image/')) {
      setDetectedType('image')
    } else if (droppedFile?.type === 'application/pdf') {
      setDetectedType('pdf')
    } else if (droppedFile?.type.startsWith('audio/')) {
      setDetectedType('voice')
    } else if (isRecording) {
      setDetectedType('voice')
    } else if (isLikelyUrl(value)) {
      setDetectedType('link')
    } else {
      setDetectedType('note')
    }
  }, [value, clipboardImage, droppedFile, isRecording])

  // Check clipboard for image on mount
  useEffect(() => {
    const checkClipboard = async (): Promise<void> => {
      try {
        const items = await navigator.clipboard.read()
        for (const item of items) {
          const imageType = item.types.find((t) => t.startsWith('image/'))
          if (imageType) {
            const blob = await item.getType(imageType)
            setClipboardImage(blob)
            setClipboardImageUrl(URL.createObjectURL(blob))
            return
          }
        }
      } catch {
        // Clipboard API may not be available or permission denied — that's fine
      }

      // No image found — load text clipboard
      try {
        const clipboardText = await window.api.quickCapture.getClipboard()
        if (
          clipboardText?.trim() &&
          !clipboardText.includes('Error:') &&
          !clipboardText.includes('at ') &&
          clipboardText.length < 5000
        ) {
          setValue(clipboardText.trim())
        }
      } catch (err) {
        log.warn('Failed to read clipboard', err)
      }

      textareaRef.current?.focus()
      textareaRef.current?.select()
    }

    checkClipboard()

    return () => {
      if (clipboardImageUrl) URL.revokeObjectURL(clipboardImageUrl)
    }
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
      const timer = setTimeout(() => window.api.quickCapture.close(), 1000)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [captureState])

  const clearAttachment = useCallback(() => {
    if (clipboardImageUrl) URL.revokeObjectURL(clipboardImageUrl)
    setClipboardImage(null)
    setClipboardImageUrl(null)
    setDroppedFile(null)
    textareaRef.current?.focus()
  }, [clipboardImageUrl])

  const handleSubmit = useCallback(
    async (force = false) => {
      if (isCapturing) return

      setCaptureState('capturing')
      setErrorMessage('')

      try {
        // Image from clipboard or dropped file
        if (clipboardImage) {
          const arrayBuffer = await clipboardImage.arrayBuffer()
          const result = await captureImage.mutateAsync({
            data: arrayBuffer,
            filename: `clipboard-${Date.now()}.png`,
            mimeType: clipboardImage.type || 'image/png',
            source: 'quick-capture'
          })
          if (result.success) {
            setCaptureState('success')
            return
          }
          setErrorMessage(extractErrorMessage(result.error, 'Failed to capture image'))
          setCaptureState('error')
          return
        }

        // Dropped file
        if (droppedFile) {
          const arrayBuffer = await droppedFile.arrayBuffer()
          if (droppedFile.type.startsWith('audio/')) {
            const result = await captureVoice.mutateAsync({
              data: arrayBuffer,
              duration: 0,
              format: droppedFile.name.split('.').pop() || 'unknown',
              transcribe: true,
              source: 'quick-capture'
            })
            if (result.success) {
              setCaptureState('success')
              return
            }
            setErrorMessage(extractErrorMessage(result.error, 'Failed to capture audio'))
            setCaptureState('error')
            return
          }
          // Image or PDF — both go through captureImage IPC
          const result = await captureImage.mutateAsync({
            data: arrayBuffer,
            filename: droppedFile.name,
            mimeType: droppedFile.type,
            source: 'quick-capture'
          })
          if (result.success) {
            setCaptureState('success')
            return
          }
          setErrorMessage(extractErrorMessage(result.error, 'Failed to capture file'))
          setCaptureState('error')
          return
        }

        // Text or URL
        const trimmed = value.trim()
        if (!trimmed) return

        if (isLikelyUrl(trimmed)) {
          const url = normalizeUrl(trimmed)
          const result = await captureLink.mutateAsync({ url, force, source: 'quick-capture' })
          if (result.duplicate && result.existingItem) {
            setDuplicateMatch(result.existingItem)
            setCaptureState('duplicate')
            return
          }
          if (result.success) {
            setCaptureState('success')
          } else {
            setErrorMessage(extractErrorMessage(result.error, 'Failed to capture link'))
            setCaptureState('error')
          }
        } else {
          const lines = trimmed.split('\n')
          const title = lines.length > 1 ? lines[0].slice(0, 100) : trimmed.slice(0, 100)
          const result = await captureText.mutateAsync({
            content: trimmed,
            title: title + (title.length < trimmed.length ? '...' : ''),
            force,
            source: 'quick-capture'
          })
          if (result.duplicate && result.existingItem) {
            setDuplicateMatch(result.existingItem)
            setCaptureState('duplicate')
            return
          }
          if (result.success) {
            setCaptureState('success')
          } else {
            setErrorMessage(extractErrorMessage(result.error, 'Failed to capture note'))
            setCaptureState('error')
          }
        }
      } catch (err) {
        setErrorMessage(extractErrorMessage(err, 'Capture failed'))
        setCaptureState('error')
      }
    },
    [
      value,
      isCapturing,
      clipboardImage,
      droppedFile,
      captureText,
      captureLink,
      captureImage,
      captureVoice
    ]
  )

  // Paste handler — intercept image paste
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const blob = item.getAsFile()
        if (blob) {
          setClipboardImage(blob)
          setClipboardImageUrl(URL.createObjectURL(blob))
          setDroppedFile(null)
        }
        return
      }
    }
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        window.api.quickCapture.close()
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  // Drag-and-drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)

      const file = e.dataTransfer.files[0]
      if (!file) return

      if (!DROPPABLE_TYPES.has(file.type)) {
        setErrorMessage(`Unsupported file type: ${file.type || 'unknown'}`)
        setCaptureState('error')
        return
      }

      setDroppedFile(file)
      setClipboardImage(null)
      if (clipboardImageUrl) URL.revokeObjectURL(clipboardImageUrl)
      setClipboardImageUrl(null)

      if (file.type.startsWith('image/')) {
        setClipboardImageUrl(URL.createObjectURL(file))
      }
    },
    [clipboardImageUrl]
  )

  // Voice recording handlers
  const handleRecordingComplete = useCallback(
    async (audioBlob: Blob, duration: number) => {
      setIsRecording(false)
      setCaptureState('capturing')
      try {
        const arrayBuffer = await audioBlob.arrayBuffer()
        const result = await captureVoice.mutateAsync({
          data: arrayBuffer,
          duration,
          format: 'webm',
          transcribe: true,
          source: 'quick-capture'
        })
        if (result.success) {
          setCaptureState('success')
        } else {
          setErrorMessage(extractErrorMessage(result.error, 'Failed to capture voice'))
          setCaptureState('error')
        }
      } catch (err) {
        setErrorMessage(extractErrorMessage(err, 'Voice capture failed'))
        setCaptureState('error')
      }
    },
    [captureVoice]
  )

  // Global escape handler
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') window.api.quickCapture.close()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Success state
  if (captureState === 'success') {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background p-4">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
            <Check className="size-6 text-green-600 dark:text-green-400" />
          </div>
          <p className="text-sm font-medium text-foreground">Captured!</p>
        </div>
      </div>
    )
  }

  // Duplicate detected state
  if (captureState === 'duplicate' && duplicateMatch) {
    const capturedDate = new Date(duplicateMatch.createdAt)
    const dateStr = capturedDate.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric'
    })

    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background p-4">
        <div className="flex w-full max-w-xs flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
            <Copy className="size-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">Already captured</p>
            <p className="mt-1 text-xs text-muted-foreground">
              &ldquo;{duplicateMatch.title.slice(0, 60)}
              {duplicateMatch.title.length > 60 ? '...' : ''}&rdquo; &middot; {dateStr}
            </p>
          </div>
          <div className="mt-1 flex gap-2">
            <button
              onClick={() => {
                setCaptureState('idle')
                setDuplicateMatch(null)
                handleSubmit(true)
              }}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              Capture Anyway
            </button>
            <button
              onClick={() => window.api.quickCapture.close()}
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-600"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Voice recording state
  if (isRecording) {
    return (
      <div className="flex h-screen w-screen flex-col bg-background p-4">
        <div className="drag-region mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="size-3 rounded-full bg-red-500" />
            <div className="size-3 rounded-full bg-yellow-500" />
            <div className="size-3 rounded-full bg-green-500" />
          </div>
          <span className="text-xs text-muted-foreground">Voice Capture</span>
          <button
            onClick={() => window.api.quickCapture.close()}
            className="rounded p-1 text-muted-foreground hover:bg-muted/50"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="flex flex-1 items-center">
          <VoiceRecorder
            onRecordingComplete={handleRecordingComplete}
            onCancel={() => setIsRecording(false)}
            maxDuration={300}
            autoStart
            className="w-full"
          />
        </div>
      </div>
    )
  }

  const TypeIcon = TYPE_ICONS[detectedType]
  const hasAttachment = !!clipboardImage || !!droppedFile

  return (
    <div
      className={cn(
        'flex h-screen w-screen flex-col bg-background p-4',
        isDragOver && 'ring-2 ring-primary/50 ring-inset'
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className="drag-region mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="size-3 rounded-full bg-red-500" />
          <div className="size-3 rounded-full bg-yellow-500" />
          <div className="size-3 rounded-full bg-green-500" />
        </div>
        <span className="text-xs text-muted-foreground">Quick Capture</span>
        <button
          onClick={() => window.api.quickCapture.close()}
          className="rounded p-1 text-muted-foreground hover:bg-muted/50"
          aria-label="Close"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Drop overlay */}
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/80">
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <Image className="size-8" />
            <span className="text-sm font-medium">Drop to capture</span>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex flex-1 flex-col min-h-0">
        {/* Image preview (clipboard or dropped image) */}
        {clipboardImageUrl && (
          <div className="relative mb-3 overflow-hidden rounded-lg border border-border/50">
            <img
              src={clipboardImageUrl}
              alt="Clipboard image"
              className="max-h-32 w-full object-contain bg-muted/20"
            />
            <button
              onClick={clearAttachment}
              className="absolute right-1.5 top-1.5 rounded-full bg-background/80 p-1 text-muted-foreground hover:text-foreground"
              aria-label="Remove image"
            >
              <X className="size-3" />
            </button>
          </div>
        )}

        {/* Dropped non-image file preview */}
        {droppedFile && !clipboardImageUrl && (
          <div className="relative mb-3 flex items-center gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            <FileIcon className="size-4 text-muted-foreground" />
            <span className="flex-1 truncate text-sm text-foreground">{droppedFile.name}</span>
            <button
              onClick={clearAttachment}
              className="rounded-full p-1 text-muted-foreground hover:text-foreground"
              aria-label="Remove file"
            >
              <X className="size-3" />
            </button>
          </div>
        )}

        {/* Input row */}
        <div
          className={cn(
            'relative flex items-start gap-3',
            'rounded-lg border border-border/50 bg-muted/30 px-3 py-2.5',
            'transition-all duration-200',
            'focus-within:border-border focus-within:bg-muted/50'
          )}
        >
          {/* Dynamic type icon */}
          <div className="mt-0.5 shrink-0 text-muted-foreground/60 transition-all duration-200">
            <TypeIcon className="size-4" aria-hidden="true" />
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
            onPaste={handlePaste}
            placeholder={
              hasAttachment ? 'Add a note (optional)...' : 'Type, paste, or drop anything...'
            }
            disabled={isCapturing}
            rows={1}
            className={cn(
              'max-h-[120px] min-h-[24px] flex-1',
              'resize-none bg-transparent',
              'text-sm text-foreground',
              'placeholder:text-muted-foreground/50',
              'focus:outline-none',
              'disabled:cursor-not-allowed disabled:opacity-50'
            )}
            aria-label="Quick capture input"
          />

          {/* Mic button */}
          <button
            onClick={() => setIsRecording(true)}
            disabled={isCapturing}
            className={cn(
              'mt-0.5 shrink-0 rounded-md p-1.5',
              'text-muted-foreground/50 transition-all duration-200',
              'hover:bg-foreground/5 hover:text-foreground/70',
              'disabled:cursor-not-allowed disabled:opacity-30'
            )}
            aria-label="Record voice memo"
          >
            <Mic className="size-4" />
          </button>

          {/* Submit button */}
          <button
            onClick={() => handleSubmit()}
            disabled={(!value.trim() && !hasAttachment) || isCapturing}
            className={cn(
              'mt-0.5 shrink-0 rounded-md p-1.5',
              'text-muted-foreground/50 transition-all duration-200',
              'hover:bg-foreground/5 hover:text-foreground/70',
              'disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent',
              (value.trim() || hasAttachment) && !isCapturing && 'text-primary'
            )}
            aria-label="Capture"
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
          <p className="mt-2 px-1 text-xs text-red-500">{errorMessage}</p>
        )}

        {/* Hint text */}
        <div className="mt-2 px-1 text-xs text-muted-foreground/50">
          <kbd className="rounded bg-muted/50 px-1 py-0.5 text-[10px]">Enter</kbd> capture
          {' · '}
          <kbd className="rounded bg-muted/50 px-1 py-0.5 text-[10px]">⌘V</kbd> paste image
          {' · '}
          <kbd className="rounded bg-muted/50 px-1 py-0.5 text-[10px]">Esc</kbd> close
        </div>
      </div>
    </div>
  )
}

export default QuickCapture
