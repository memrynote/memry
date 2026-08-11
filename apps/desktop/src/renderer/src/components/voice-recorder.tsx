import { forwardRef, useState, useRef, useCallback, useEffect, useImperativeHandle } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Mic, Square, X, Loader2, Settings, AlertCircle } from '@/lib/icons'
import { isInputFocused } from '@/hooks/use-keyboard-shortcuts'
import {
  useVoiceCapture,
  VOICE_CAPTURE_MAX_DURATION,
  type VoiceCaptureError
} from '@/hooks/use-voice-capture'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { useT } from '@memry/i18n/renderer'
import { getI18n } from 'react-i18next'

const log = createLogger('Component:VoiceRecorder')

interface VoiceRecorderProps {
  onRecordingComplete: (audioBlob: Blob, duration: number) => void
  onCancel: () => void
  maxDuration?: number
  className?: string
}

export interface VoiceRecorderHandle {
  start: () => Promise<void>
}

const WAVEFORM_BAR_COUNT = 40
const WAVEFORM_FFT_SIZE = 512
const MIN_BAR_HEIGHT = 3
const MAX_BAR_HEIGHT = 18

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function getBarOpacity(index: number, total: number): number {
  const position = index / total
  if (position > 0.85) return 0.15
  if (position > 0.7) return 0.3
  return 0.4 + position * 0.6
}

function createWaveformBars(): number[] {
  return Array.from({ length: WAVEFORM_BAR_COUNT }, () => MIN_BAR_HEIGHT)
}

const TIME_WARNING_SECONDS = 30

export const VoiceRecorder = forwardRef<VoiceRecorderHandle, VoiceRecorderProps>(
  function VoiceRecorder(
    {
      onRecordingComplete,
      onCancel,
      maxDuration = VOICE_CAPTURE_MAX_DURATION,
      className
    }: VoiceRecorderProps,
    ref
  ): React.JSX.Element {
    const { t: tPhaseF } = useT('inbox')
    const prefersReducedMotion = useReducedMotion()
    const [error, setError] = useState<string | null>(null)
    const [permissionDenied, setPermissionDenied] = useState(false)
    const [waveformBars, setWaveformBars] = useState<number[]>(createWaveformBars)

    const audioContextRef = useRef<AudioContext | null>(null)
    const analyserRef = useRef<AnalyserNode | null>(null)
    const rafRef = useRef<number | null>(null)
    const barsRef = useRef<number[]>(createWaveformBars())

    const cleanupAudio = useCallback(() => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      if (audioContextRef.current) {
        void audioContextRef.current.close().catch(() => {})
        audioContextRef.current = null
      }
      analyserRef.current = null
    }, [])

    const startWaveformAnalysis = useCallback((stream: MediaStream) => {
      try {
        const audioContext = new AudioContext()
        const source = audioContext.createMediaStreamSource(stream)
        const analyser = audioContext.createAnalyser()
        // The bars are an RMS level meter, not a spectrum: no frequency
        // resolution is needed, only a time-domain window long enough for a
        // steady reading. 512 samples is ~12 ms at 44.1 kHz — plenty at the
        // 20 fps the bars redraw at, and a quarter of the per-sample work.
        analyser.fftSize = WAVEFORM_FFT_SIZE
        source.connect(analyser)

        audioContextRef.current = audioContext
        analyserRef.current = analyser

        const bufferLength = analyser.fftSize
        const dataArray = new Uint8Array(bufferLength)
        let lastUpdateTime = 0
        const UPDATE_INTERVAL = 50

        const updateBars = (timestamp: number) => {
          if (!analyserRef.current) return

          // Sample only on the frames we actually commit. The read + RMS loop
          // used to run at display rate while this throttle threw away ~2 of
          // every 3 results; the bars still advance at the same 20 fps.
          if (timestamp - lastUpdateTime >= UPDATE_INTERVAL) {
            analyserRef.current.getByteTimeDomainData(dataArray)

            let sum = 0
            for (let i = 0; i < bufferLength; i++) {
              const amplitude = (dataArray[i] - 128) / 128
              sum += amplitude * amplitude
            }
            const rms = Math.sqrt(sum / bufferLength)

            const SENSITIVITY = 4.0
            const normalized = Math.min(rms * SENSITIVITY, 1)
            const height = MIN_BAR_HEIGHT + normalized * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT)

            const next = [...barsRef.current.slice(1), height]
            barsRef.current = next
            setWaveformBars(next)
            lastUpdateTime = timestamp
          }

          rafRef.current = requestAnimationFrame(updateBars)
        }

        rafRef.current = requestAnimationFrame(updateBars)
      } catch (err) {
        log.error('Failed to start waveform analysis', err)
      }
    }, [])

    const resetWaveform = useCallback(() => {
      const emptyBars = createWaveformBars()
      barsRef.current = emptyBars
      setWaveformBars(emptyBars)
    }, [])

    const handleCaptureError = useCallback(
      (captureError: VoiceCaptureError) => {
        if (captureError.kind === 'permission-denied') {
          setPermissionDenied(true)
          setError(tPhaseF('phaseF.componentsVoiceRecorder.microphoneAccessDenied'))
          return
        }

        if (captureError.kind === 'no-microphone') {
          setError(tPhaseF('phaseF.componentsVoiceRecorder.noMicrophoneFound'))
          return
        }

        if (captureError.kind === 'access-failed') {
          setError(
            extractErrorMessage(
              captureError.cause,
              getI18n().getFixedT(null, 'common')('phaseI.errors.failedToAccessMicrophone')
            )
          )
          return
        }

        if (captureError.kind === 'recorder-failed') {
          setError(tPhaseF('phaseF.componentsVoiceRecorder.recordingError'))
          return
        }

        setError(tPhaseF('phaseF.componentsVoiceRecorder.failedToStart'))
      },
      [tPhaseF]
    )

    const { state, duration, stream, start, stop, cancel } = useVoiceCapture({
      maxDuration,
      onComplete: onRecordingComplete,
      onError: handleCaptureError
    })

    useEffect(() => {
      if (!stream) return

      startWaveformAnalysis(stream)

      return () => {
        cleanupAudio()
        resetWaveform()
      }
    }, [stream, startWaveformAnalysis, cleanupAudio, resetWaveform])

    const startRecording = useCallback(async () => {
      setError(null)
      setPermissionDenied(false)
      await start()
    }, [start])

    useImperativeHandle(
      ref,
      () => ({
        start: startRecording
      }),
      [startRecording]
    )

    const handleStop = useCallback(() => {
      stop()
    }, [stop])

    const handleCancel = useCallback(() => {
      cancel()
      onCancel()
    }, [cancel, onCancel])

    // Keyboard parity while the mic is hot: Esc cancels anywhere; Enter/Space
    // stop unless the user is typing in an input. Capture phase so list-level
    // shortcuts (quick-file Escape etc.) don't race the recorder.
    useEffect(() => {
      if (state !== 'recording') return
      const onKeyDown = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          handleCancel()
        } else if ((e.key === 'Enter' || e.key === ' ') && !isInputFocused()) {
          e.preventDefault()
          e.stopPropagation()
          handleStop()
        }
      }
      window.addEventListener('keydown', onKeyDown, true)
      return () => window.removeEventListener('keydown', onKeyDown, true)
    }, [state, handleCancel, handleStop])

    const openSettings = useCallback(() => {
      // Hint first, then deep-link to the OS privacy pane where available
      // (macOS/Windows); the hint is the fallback for platforms without one.
      setError(tPhaseF('phaseF.componentsVoiceRecorder.enableMicInSettings'))
      void window.api.settings.openOsMicrophoneSettings?.()?.catch(() => {})
    }, [tPhaseF])

    const handleStartClick = useCallback(() => {
      void startRecording()
    }, [startRecording])

    if (state === 'idle' && !error) {
      return (
        <Button
          variant="ghost"
          size="icon"
          onClick={handleStartClick}
          className={cn(
            'h-8 w-8 text-muted-foreground hover:text-foreground',
            'transition-all duration-150 ease-out active:scale-90',
            className
          )}
          aria-label={tPhaseF('phaseF.componentsVoiceRecorder.startVoiceRecording')}
        >
          <Mic className="size-4" />
        </Button>
      )
    }

    if (state === 'requesting-permission') {
      return (
        <div
          className={cn(
            'flex items-center gap-2 px-3 py-2 rounded-md bg-muted/50',
            'text-sm text-muted-foreground',
            className
          )}
        >
          <Loader2 className="size-4 animate-spin" />
          <span>{tPhaseF('phaseF.componentsVoiceRecorder.requestingMicrophoneAccess')}</span>
        </div>
      )
    }

    if (error) {
      return (
        <div
          className={cn(
            'flex items-center gap-2 px-3 py-2 rounded-md bg-destructive/10',
            'text-sm',
            className
          )}
        >
          <AlertCircle className="size-4 text-destructive" />
          <span className="text-destructive/90 flex-1">{error}</span>
          {permissionDenied && (
            <Button variant="ghost" size="sm" onClick={openSettings} className="h-7 px-2 text-xs">
              <Settings className="size-3 me-1" />

              {tPhaseF('phaseF.componentsVoiceRecorder.settings')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleCancel}
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </Button>
        </div>
      )
    }

    if (state === 'processing') {
      return (
        <div
          className={cn(
            'flex items-center gap-2 px-3 py-2 rounded-md bg-muted/50',
            'text-sm text-muted-foreground',
            className
          )}
        >
          <Loader2 className="size-4 animate-spin" />
          <span>{tPhaseF('phaseF.componentsVoiceRecorder.processing')}</span>
        </div>
      )
    }

    const remaining = maxDuration - duration

    return (
      <motion.div
        initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
        style={{ transformOrigin: getI18n().dir() === 'rtl' ? '0% 50%' : '100% 50%' }}
        className={cn(
          'flex max-h-10 min-w-0 items-center gap-2 overflow-hidden rounded-[10px] px-2.5 py-1.5',
          'bg-muted-foreground/[0.04] border border-muted-foreground/15',
          className
        )}
      >
        <div className="flex items-center justify-center shrink-0 size-2.5">
          {/* Recording is unmistakably live: red, universally */}
          <div className="rounded-sm bg-red-500 shrink-0 size-2 animate-pulse motion-reduce:animate-none" />
        </div>

        <div
          className={cn(
            'w-10 shrink-0 font-mono text-xs/[16px] font-medium tabular-nums transition-colors',
            remaining <= TIME_WARNING_SECONDS
              ? 'text-amber-600 dark:text-amber-500'
              : 'text-foreground'
          )}
        >
          {formatTime(duration)}
        </div>

        <div className="flex h-5 min-w-0 grow items-center gap-0.5 overflow-hidden">
          {waveformBars.map((height, i) => (
            <div
              key={i}
              className="w-0.5 rounded-[1px] bg-muted-foreground shrink-0 transition-[height] duration-75"
              style={{
                height: `${height}px`,
                opacity: getBarOpacity(i, WAVEFORM_BAR_COUNT)
              }}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={handleCancel}
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-md',
            'border border-border/50 text-muted-foreground',
            'hover:bg-muted/50 transition-all duration-150 ease-out active:scale-90'
          )}
          aria-label={tPhaseF('phaseF.componentsVoiceRecorder.cancelRecording')}
        >
          <X className="size-3" />
        </button>

        <button
          type="button"
          onClick={handleStop}
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-md',
            'bg-foreground text-background',
            'hover:bg-foreground/90 transition-all duration-150 ease-out active:scale-90'
          )}
          aria-label={tPhaseF('phaseF.componentsVoiceRecorder.stopRecording')}
        >
          <Square className="size-2.5 fill-current" />
        </button>
      </motion.div>
    )
  }
)
