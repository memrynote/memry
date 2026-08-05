import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import { useT } from '@memry/i18n/renderer'

import { useSettingsModal } from '@/contexts/settings-modal-context'
import { useVoiceCapture, type VoiceCaptureError } from '@/hooks/use-voice-capture'
import { Loader2, Mic } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { prepareVoiceMemoAudio } from '@/lib/voice-memo-audio'
import {
  ensureVoiceRecordingReady,
  getVoiceRecordingSettingsTarget
} from '@/lib/voice-recording-readiness'

const log = createLogger('AgentChat:VoiceDictation')

interface VoiceDictationButtonProps {
  disabled?: boolean
  onTranscript: (text: string) => void
}

/**
 * Dictation control for the agent composer. Deliberately stays a single
 * `size-7` button in every state — recording only turns the icon red, and
 * transcription swaps the mic for a spinner — so the toolbar never reflows.
 */
export function VoiceDictationButton({
  disabled = false,
  onTranscript
}: VoiceDictationButtonProps): React.JSX.Element {
  const { t } = useT('common')
  const { open: openSettings } = useSettingsModal()
  const [transcribing, setTranscribing] = useState(false)

  const handleCaptureError = useCallback(
    (captureError: VoiceCaptureError) => {
      if (captureError.kind === 'permission-denied') {
        toast.error(t('agentChat.composer.voice.errors.permissionDenied'))
        return
      }

      if (captureError.kind === 'no-microphone') {
        toast.error(t('agentChat.composer.voice.errors.noMicrophone'))
        return
      }

      if (captureError.kind === 'access-failed') {
        toast.error(
          extractErrorMessage(captureError.cause, t('agentChat.composer.voice.errors.accessFailed'))
        )
        return
      }

      toast.error(t('agentChat.composer.voice.errors.recordingFailed'))
    },
    [t]
  )

  const handleComplete = useCallback(
    (audioBlob: Blob) => {
      setTranscribing(true)

      void (async () => {
        try {
          const prepared = await prepareVoiceMemoAudio(audioBlob)
          const result = await window.api.inbox.transcribeAudio({
            data: prepared.data,
            format: prepared.format,
            duration: prepared.duration
          })

          if (!result.success) {
            toast.error(
              extractErrorMessage(
                result.error,
                t('agentChat.composer.voice.errors.transcriptionFailed')
              )
            )
            return
          }

          const text = result.text.trim()
          if (text) onTranscript(text)
        } catch (err) {
          log.error('Voice dictation failed', err)
          toast.error(
            extractErrorMessage(err, t('agentChat.composer.voice.errors.transcriptionFailed'))
          )
        } finally {
          setTranscribing(false)
        }
      })()
    },
    [onTranscript, t]
  )

  const { state, start, stop } = useVoiceCapture({
    onComplete: handleComplete,
    onError: handleCaptureError
  })

  const recording = state === 'requesting-permission' || state === 'recording'

  const handleClick = useCallback(() => {
    if (transcribing) return

    if (recording) {
      stop()
      return
    }

    void (async () => {
      const ready = await ensureVoiceRecordingReady((readiness) =>
        openSettings(getVoiceRecordingSettingsTarget(readiness))
      )
      if (!ready) return
      await start()
    })()
  }, [openSettings, recording, start, stop, transcribing])

  const label = transcribing
    ? t('agentChat.composer.voice.transcribing')
    : recording
      ? t('agentChat.composer.voice.stop')
      : t('agentChat.composer.voice.start')

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={handleClick}
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-md transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        recording ? 'text-destructive' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {transcribing ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Mic className="size-3.5" aria-hidden="true" />
      )}
    </button>
  )
}
