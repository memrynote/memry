import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { flushSync } from 'react-dom'
import { Image, Loader2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useCaptureText, useCaptureLink, useCaptureImage, useCaptureVoice } from '@/hooks/use-inbox'
import { VoiceRecorder, type VoiceRecorderHandle } from './voice-recorder'
import { QuickCaptureInput } from './quick-capture-input'
import { QuickCaptureFooter } from './quick-capture-footer'
import { CaptureSuccess, CaptureError, CaptureDuplicate } from './quick-capture-states'
import { LinkPreviewCard } from './quick-capture-link-preview'
import { FilePreviewCard, formatFileSize } from './quick-capture-image-preview'
import { detectPlatformFromUrl, extractHandleFromUrl } from './social-card'
import { createLogger } from '@/lib/logger'
import { ensureVoiceRecordingReady } from '@/lib/voice-recording-readiness'
import { prepareVoiceMemoAudio } from '@/lib/voice-memo-audio'

const log = createLogger('Component:QuickCapture')

type CaptureState = 'idle' | 'capturing' | 'success' | 'error' | 'duplicate'
type DetectedType = 'note' | 'link' | 'image' | 'voice' | 'pdf' | 'social'

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
  const voiceRecorderRef = useRef<VoiceRecorderHandle | null>(null)

  const captureText = useCaptureText()
  const captureLink = useCaptureLink()
  const captureImage = useCaptureImage()
  const captureVoice = useCaptureVoice()

  const [linkPreview, setLinkPreview] = useState<{
    title: string
    domain: string
    favicon?: string
    description?: string
  } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const previewUrlRef = useRef<string | null>(null)

  const isCapturing = captureState === 'capturing'
  const hasAttachment = !!clipboardImage || !!droppedFile

  const attachmentFilename =
    droppedFile?.name ??
    (clipboardImage ? `clipboard-${new Date().toISOString().slice(0, 10)}.png` : '')
  const attachmentSize = droppedFile?.size ?? clipboardImage?.size ?? 0
  const attachmentExtension = droppedFile
    ? (droppedFile.name.split('.').pop() ?? droppedFile.type.split('/')[1] ?? 'unknown')
    : (clipboardImage?.type.split('/')[1] ?? 'png')
  const detectedType = useMemo<DetectedType>(() => {
    if (clipboardImage || droppedFile?.type.startsWith('image/')) {
      return 'image'
    }
    if (droppedFile?.type === 'application/pdf') {
      return 'pdf'
    }
    if (droppedFile?.type.startsWith('audio/')) {
      return 'voice'
    }
    if (isRecording) {
      return 'voice'
    }
    if (isLikelyUrl(value)) {
      const url = normalizeUrl(value.trim())
      return detectPlatformFromUrl(url) === 'twitter' ? 'social' : 'link'
    }
    return 'note'
  }, [clipboardImage, droppedFile, isRecording, value])
  const isLinkPreviewVisible = detectedType === 'link'

  useEffect(() => {
    if (!isLinkPreviewVisible) {
      setLinkPreview(null)
      setPreviewLoading(false)
      previewUrlRef.current = null
      return
    }
    const url = normalizeUrl(value.trim())
    if (url === previewUrlRef.current) return

    setPreviewLoading(true)
    const timer = setTimeout(() => {
      void (async () => {
        previewUrlRef.current = url
        try {
          const data = await window.api.inbox.previewLink(url)
          setLinkPreview(data)
        } catch {
          setLinkPreview(null)
        } finally {
          setPreviewLoading(false)
        }
      })()
    }, 500)
    return () => clearTimeout(timer)
  }, [isLinkPreviewVisible, value])

  useEffect(() => {
    const checkClipboard = async (): Promise<void> => {
      try {
        const items = await navigator.clipboard.read()
        for (const item of items) {
          const imageType = item.types.find((t) => t.startsWith('image/'))
          if (imageType) {
            const blob = await item.getType(imageType)
            const imageUrl = URL.createObjectURL(blob)
            setClipboardImage(blob)
            setClipboardImageUrl(imageUrl)
            setValue(`clipboard-${new Date().toISOString().slice(0, 10)}.png`)
            return
          }
        }
      } catch {
        // Clipboard API may not be available or permission denied
      }

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

    const timeoutId = window.setTimeout(() => {
      void checkClipboard()
    }, 0)

    return () => clearTimeout(timeoutId)
  }, [])

  useEffect(() => {
    return () => {
      if (clipboardImageUrl) {
        URL.revokeObjectURL(clipboardImageUrl)
      }
    }
  }, [clipboardImageUrl])

  const clearAttachment = useCallback(() => {
    if (clipboardImageUrl) URL.revokeObjectURL(clipboardImageUrl)
    setClipboardImage(null)
    setClipboardImageUrl(null)
    setDroppedFile(null)
    textareaRef.current?.focus()
  }, [clipboardImageUrl])

  const handleSubmit = useCallback(
    (force = false): void => {
      void (async () => {
        if (isCapturing) return

        setCaptureState('capturing')
        setErrorMessage('')

        try {
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

          if (droppedFile) {
            if (droppedFile.type.startsWith('audio/')) {
              const ready = await ensureVoiceRecordingReady(() => {
                window.api.quickCapture.openSettings('ai')
              })

              if (!ready) {
                setCaptureState('idle')
                return
              }

              const preparedAudio = await prepareVoiceMemoAudio(droppedFile)
              const result = await captureVoice.mutateAsync({
                data: preparedAudio.data,
                duration: preparedAudio.duration,
                format: preparedAudio.format,
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
            const arrayBuffer = await droppedFile.arrayBuffer()
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

          const trimmed = value.trim()
          if (!trimmed) {
            setCaptureState('idle')
            return
          }

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
      })()
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

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const blob = item.getAsFile()
        if (blob) {
          const imageUrl = URL.createObjectURL(blob)
          setClipboardImage(blob)
          setClipboardImageUrl(imageUrl)
          setDroppedFile(null)
          setValue(`clipboard-${new Date().toISOString().slice(0, 10)}.png`)
        }
        return
      }
    }
  }, [])

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
      setValue(file.name)

      if (file.type.startsWith('image/')) {
        setClipboardImageUrl(URL.createObjectURL(file))
      }
    },
    [clipboardImageUrl]
  )

  const handleRecordingComplete = useCallback(
    (audioBlob: Blob, duration: number): void => {
      setIsRecording(false)
      setCaptureState('capturing')
      void (async () => {
        try {
          const preparedAudio = await prepareVoiceMemoAudio(audioBlob)
          const result = await captureVoice.mutateAsync({
            data: preparedAudio.data,
            duration: duration || preparedAudio.duration,
            format: preparedAudio.format,
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
      })()
    },
    [captureVoice]
  )

  const handleFileSelected = useCallback(
    (e: Event) => {
      const file = (e as CustomEvent<File>).detail
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
      setValue(file.name)

      if (file.type.startsWith('image/')) {
        setClipboardImageUrl(URL.createObjectURL(file))
      }
    },
    [clipboardImageUrl]
  )

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') window.api.quickCapture.close()
    }
    window.addEventListener('keydown', handler)
    window.addEventListener('quick-capture:file-selected', handleFileSelected)
    return () => {
      window.removeEventListener('keydown', handler)
      window.removeEventListener('quick-capture:file-selected', handleFileSelected)
    }
  }, [handleFileSelected])

  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height
      if (height && height > 0) {
        window.api.quickCapture.resize(Math.ceil(height) + 2)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const handleValueChange = useCallback(
    (newValue: string) => {
      setValue(newValue)
      if (captureState === 'error') {
        setCaptureState('idle')
        setErrorMessage('')
      }
    },
    [captureState]
  )

  return (
    <div
      ref={containerRef}
      className={cn(
        'drag-region flex w-screen flex-col',
        'bg-background rounded-[14px] overflow-hidden',
        'border border-border/30',
        isDragOver && 'ring-2 ring-accent-orange/40 ring-inset'
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[14px] bg-background/80">
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <Image className="size-8" />
            <span className="text-sm font-medium">Drop to capture</span>
          </div>
        </div>
      )}

      {captureState === 'success' ? (
        <CaptureSuccess onAutoClose={() => window.api.quickCapture.close()} />
      ) : captureState === 'capturing' && !value.trim() && hasAttachment ? (
        <div className="flex items-center gap-2.5 px-4 py-3.5">
          <Loader2 className="size-4 animate-spin text-accent-orange" />
          <span className="text-sm text-muted-foreground">Capturing...</span>
        </div>
      ) : (
        <>
          {captureState === 'duplicate' && duplicateMatch ? (
            <CaptureDuplicate
              title={duplicateMatch.title}
              createdAt={duplicateMatch.createdAt}
              onForce={() => {
                setCaptureState('idle')
                setDuplicateMatch(null)
                handleSubmit(true)
              }}
              onClose={() => window.api.quickCapture.close()}
            />
          ) : (
            <QuickCaptureInput
              value={value}
              onChange={handleValueChange}
              onSubmit={() => handleSubmit()}
              onStartRecording={() => {
                void ensureVoiceRecordingReady(() => {
                  window.api.quickCapture.openSettings('ai')
                }).then((ready) => {
                  if (ready) {
                    flushSync(() => {
                      setIsRecording(true)
                      setValue('Voice memo')
                    })
                    void voiceRecorderRef.current?.start()
                  }
                })
              }}
              onPaste={handlePaste}
              detectedType={detectedType}
              isCapturing={isCapturing || isRecording}
              hasAttachment={hasAttachment}
              textareaRef={textareaRef}
            />
          )}

          {(linkPreview || previewLoading) && detectedType === 'link' && (
            <LinkPreviewCard
              title={linkPreview?.title ?? ''}
              domain={linkPreview?.domain ?? ''}
              favicon={linkPreview?.favicon}
              loading={previewLoading}
            />
          )}

          {hasAttachment && detectedType === 'image' && (
            <FilePreviewCard
              variant="image"
              title={value || attachmentFilename}
              subtitle={`${formatFileSize(attachmentSize)} · ${attachmentExtension.toUpperCase()}`}
              initial={attachmentExtension.charAt(0).toUpperCase()}
              onClear={clearAttachment}
            />
          )}

          {hasAttachment && detectedType === 'pdf' && (
            <FilePreviewCard
              variant="pdf"
              title={value || attachmentFilename}
              subtitle={`${formatFileSize(attachmentSize)} · PDF`}
              onClear={clearAttachment}
            />
          )}

          {detectedType === 'social' && (
            <FilePreviewCard
              variant="social"
              title={extractHandleFromUrl(normalizeUrl(value.trim())) || 'Social post'}
              subtitle="x.com"
              onClear={() => {}}
            />
          )}

          {isRecording && (
            <div className="px-3 py-2 border-t border-border/30 bg-foreground/[0.02]">
              <VoiceRecorder
                ref={voiceRecorderRef}
                onRecordingComplete={handleRecordingComplete}
                onCancel={() => setIsRecording(false)}
                maxDuration={300}
                className="w-full"
              />
            </div>
          )}

          {captureState === 'error' && errorMessage && (
            <CaptureError
              message={errorMessage}
              onDismiss={() => {
                setCaptureState('idle')
                setErrorMessage('')
              }}
            />
          )}
        </>
      )}

      <QuickCaptureFooter />
    </div>
  )
}

export default QuickCapture
