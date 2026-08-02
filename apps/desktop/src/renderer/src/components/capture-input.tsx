import { getI18n } from 'react-i18next'
/**
 * Inbox capture — the CaptureBar wired to the inbox.
 *
 * Auto-detects URLs vs plain text and uses the matching capture method, records
 * voice memos with transcription, and accepts file attachments. Geometry and
 * keyboard behaviour come from CaptureBar, shared with Tasks and the Project hub.
 */

import { useCallback, useRef, useState } from 'react'
import { Copy } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useCaptureText, useCaptureLink, useCaptureVoice, useCaptureImage } from '@/hooks/use-inbox'
import { useAISettingsContext } from '@/contexts/ai-settings-context'
import { useSettingsModal } from '@/contexts/settings-modal-context'
import {
  ensureVoiceRecordingReady,
  getVoiceRecordingSettingsTarget
} from '@/lib/voice-recording-readiness'
import { prepareVoiceMemoAudio } from '@/lib/voice-memo-audio'
import { useT } from '@memry/i18n/renderer'
import { isLikelyUrl, normalizeUrl } from '@/lib/capture-intent'
import { CaptureBar } from '@/components/capture-bar'

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
  className?: string
  /** Bump to focus the capture field (changes each time to re-fire). */
  focusSignal?: number
}

export function CaptureInput({
  onCaptureSuccess,
  onCaptureError,
  className,
  focusSignal
}: CaptureInputProps): React.JSX.Element {
  const { t } = useT('inbox')
  const [duplicateMatch, setDuplicateMatch] = useState<{
    id: string
    title: string
    createdAt: string
  } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // The text the duplicate notice refers to — CaptureBar keeps it in the field
  // while the notice is up, so "Capture Anyway" resubmits exactly this.
  const pendingTextRef = useRef('')
  const [clearSignal, setClearSignal] = useState(0)
  const { enabled: aiEnabled } = useAISettingsContext()

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

  /**
   * Returns false when the text must stay in the field: a duplicate the user
   * still has to decide about, or a failed capture.
   */
  const handleSubmit = useCallback(
    async (text: string, force = false): Promise<boolean> => {
      setDuplicateMatch(null)

      try {
        if (isLikelyUrl(text)) {
          const result = await captureLink.mutateAsync({
            url: normalizeUrl(text),
            force,
            source: 'inline'
          })
          if (result.duplicate && result.existingItem) {
            setDuplicateMatch(result.existingItem)
            return false
          }
          if (result.success) {
            onCaptureSuccess?.()
            return true
          }
          onCaptureError?.(
            extractErrorMessage(
              result.error,
              getI18n().getFixedT(null, 'inbox')('phaseI.errors.failedToCaptureLink')
            )
          )
          return false
        }

        const lines = text.split('\n')
        const title = lines.length > 1 ? lines[0].slice(0, 100) : text.slice(0, 100)

        const result = await captureText.mutateAsync({
          content: text,
          title: title + (title.length < text.length ? '...' : ''),
          force,
          source: 'inline'
        })
        if (result.duplicate && result.existingItem) {
          setDuplicateMatch(result.existingItem)
          return false
        }
        if (result.success) {
          onCaptureSuccess?.()
          return true
        }
        onCaptureError?.(
          extractErrorMessage(
            result.error,
            getI18n().getFixedT(null, 'inbox')('phaseI.errors.failedToCaptureNote')
          )
        )
        return false
      } catch (err) {
        onCaptureError?.(
          extractErrorMessage(
            err,
            getI18n().getFixedT(null, 'inbox')('phaseI.errors.captureFailed')
          )
        )
        return false
      }
    },
    [captureText, captureLink, onCaptureSuccess, onCaptureError]
  )

  const handleRecordingComplete = useCallback(
    async (audioBlob: Blob, duration: number): Promise<void> => {
      try {
        const preparedAudio = await prepareVoiceMemoAudio(audioBlob)

        const result = await captureVoice.mutateAsync({
          data: preparedAudio.data,
          duration: duration || preparedAudio.duration,
          format: preparedAudio.format,
          transcribe: true,
          source: 'inline',
          waveform: preparedAudio.waveform
        })

        if (result.success) {
          onCaptureSuccess?.()
        } else {
          onCaptureError?.(
            extractErrorMessage(
              result.error,
              getI18n().getFixedT(null, 'inbox')('phaseI.errors.failedToCaptureVoiceMemo')
            )
          )
        }
      } catch (err) {
        onCaptureError?.(
          extractErrorMessage(
            err,
            getI18n().getFixedT(null, 'inbox')('phaseI.errors.voiceCaptureFailed')
          )
        )
      }
    },
    [captureVoice, onCaptureSuccess, onCaptureError]
  )

  const handleVoiceReadiness = useCallback(
    () =>
      ensureVoiceRecordingReady((readiness) =>
        openSettings(getVoiceRecordingSettingsTarget(readiness))
      ),
    [openSettings]
  )

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
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
          onCaptureError?.(
            extractErrorMessage(
              result.error,
              getI18n().getFixedT(null, 'inbox')('phaseI.errors.failedToCaptureFile')
            )
          )
        }
      } catch (err) {
        onCaptureError?.(
          extractErrorMessage(
            err,
            getI18n().getFixedT(null, 'inbox')('phaseI.errors.fileCaptureFailed')
          )
        )
      }
    },
    [captureImage, onCaptureSuccess, onCaptureError]
  )

  return (
    <>
      <CaptureBar
        className={className}
        icon="auto"
        ariaLabel={t('phaseF.componentsCaptureInput.captureInput')}
        placeholder={t('phaseF.componentsCaptureInput.placeholder')}
        isBusy={isCapturing}
        focusSignal={focusSignal}
        clearSignal={clearSignal}
        onSubmit={(text) => {
          pendingTextRef.current = text
          return handleSubmit(text)
        }}
        submitLabel={(value) =>
          isLikelyUrl(value)
            ? t('phaseF.componentsCaptureInput.captureLink')
            : t('phaseF.componentsCaptureInput.captureNote')
        }
        attachment={{
          onAttach: () => fileInputRef.current?.click(),
          label: t('phaseF.componentsCaptureInput.attachFile'),
          title: t('phaseF.componentsCaptureInput.attachFileImagesAudioVideoPdf')
        }}
        voice={
          aiEnabled
            ? {
                onComplete: handleRecordingComplete,
                onBeforeStart: handleVoiceReadiness,
                label: t('phaseF.componentsCaptureInput.recordVoiceMemo'),
                title: t('phaseF.componentsCaptureInput.recordVoiceMemo2')
              }
            : undefined
        }
        footer={
          duplicateMatch ? (
            <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
              <Copy className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="flex-1 text-xs text-muted-foreground">
                {t('phaseF.componentsCaptureInput.alreadyCaptured')}
                {duplicateMatch.title.slice(0, 50)}
                {duplicateMatch.title.length > 50 ? '...' : ''}&
                {t('phaseF.componentsCaptureInput.rdquo')}
              </p>
              <button
                type="button"
                onClick={() => {
                  void handleSubmit(pendingTextRef.current, true).then((cleared) => {
                    if (cleared) setClearSignal((n) => n + 1)
                  })
                }}
                className="shrink-0 text-xs font-medium text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
              >
                {t('phaseF.componentsCaptureInput.captureAnyway')}
              </button>
            </div>
          ) : null
        }
      />

      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_ATTACHMENT_TYPES.join(',')}
        onChange={(...args) => void handleFileSelect(...args)}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
      />
    </>
  )
}
