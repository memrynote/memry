import { useState, useRef, useCallback, useEffect } from 'react'
import { Mic, Square, X, Loader2, Settings, AlertCircle } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:VoiceRecorder')

type RecordingState = 'idle' | 'requesting-permission' | 'recording' | 'processing'

interface VoiceRecorderProps {
  onRecordingComplete: (audioBlob: Blob, duration: number) => void
  onCancel: () => void
  maxDuration?: number
  autoStart?: boolean
  className?: string
}

const DEFAULT_MAX_DURATION = 300
const MIME_TYPE = 'audio/webm'
const WAVEFORM_BAR_COUNT = 40
const MIN_BAR_HEIGHT = 4
const MAX_BAR_HEIGHT = 28

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

export function VoiceRecorder({
  onRecordingComplete,
  onCancel,
  maxDuration = DEFAULT_MAX_DURATION,
  autoStart = false,
  className
}: VoiceRecorderProps): React.JSX.Element {
  const [state, setState] = useState<RecordingState>('idle')
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [waveformBars, setWaveformBars] = useState<number[]>(() =>
    Array.from({ length: WAVEFORM_BAR_COUNT }, () => MIN_BAR_HEIGHT)
  )

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<number | null>(null)
  const startTimeRef = useRef<number>(0)

  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const barsRef = useRef<number[]>(Array.from({ length: WAVEFORM_BAR_COUNT }, () => MIN_BAR_HEIGHT))

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
      analyser.fftSize = 2048
      source.connect(analyser)

      audioContextRef.current = audioContext
      analyserRef.current = analyser

      const bufferLength = analyser.fftSize
      const dataArray = new Uint8Array(bufferLength)
      let lastUpdateTime = 0
      const UPDATE_INTERVAL = 50

      const updateBars = (timestamp: number) => {
        if (!analyserRef.current) return

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

        if (timestamp - lastUpdateTime >= UPDATE_INTERVAL) {
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

  useEffect(() => {
    return () => {
      stopRecording(true)
      cleanupAudio()
    }
  }, [])

  useEffect(() => {
    if (autoStart && state === 'idle') {
      void startRecording()
    }
  }, [autoStart])

  const stopRecording = useCallback(
    (cancelled = false) => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }

      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop()
      }

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
        streamRef.current = null
      }

      cleanupAudio()

      if (cancelled) {
        chunksRef.current = []
        setState('idle')
        setDuration(0)
        setWaveformBars(Array.from({ length: WAVEFORM_BAR_COUNT }, () => MIN_BAR_HEIGHT))
        barsRef.current = Array.from({ length: WAVEFORM_BAR_COUNT }, () => MIN_BAR_HEIGHT)
      }
    },
    [cleanupAudio]
  )

  const startRecording = useCallback(async () => {
    setError(null)
    setPermissionDenied(false)
    setState('requesting-permission')

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100
        }
      })

      streamRef.current = stream
      chunksRef.current = []

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported(MIME_TYPE) ? MIME_TYPE : 'audio/webm'
      })

      mediaRecorderRef.current = mediaRecorder

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }

      mediaRecorder.onstop = () => {
        if (chunksRef.current.length > 0) {
          setState('processing')

          const blob = new Blob(chunksRef.current, { type: MIME_TYPE })
          const finalDuration = (Date.now() - startTimeRef.current) / 1000

          chunksRef.current = []
          onRecordingComplete(blob, finalDuration)

          setState('idle')
          setDuration(0)
        } else {
          setState('idle')
          setDuration(0)
        }
      }

      mediaRecorder.onerror = (event) => {
        log.error('MediaRecorder error', event)
        setError('Recording error occurred')
        stopRecording(true)
      }

      mediaRecorder.start()
      startTimeRef.current = Date.now()
      setState('recording')
      setDuration(0)

      startWaveformAnalysis(stream)

      timerRef.current = window.setInterval(() => {
        const elapsed = (Date.now() - startTimeRef.current) / 1000
        setDuration(elapsed)

        if (elapsed >= maxDuration) {
          stopRecording(false)
        }
      }, 100)
    } catch (err) {
      log.error('Failed to start recording', err)

      if (err instanceof DOMException) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          setPermissionDenied(true)
          setError('Microphone access denied')
        } else if (err.name === 'NotFoundError') {
          setError('No microphone found')
        } else {
          setError(extractErrorMessage(err, 'Failed to access microphone'))
        }
      } else {
        setError('Failed to start recording')
      }

      setState('idle')
    }
  }, [maxDuration, onRecordingComplete, stopRecording, startWaveformAnalysis])

  const handleStop = useCallback(() => {
    stopRecording(false)
  }, [stopRecording])

  const handleCancel = useCallback(() => {
    stopRecording(true)
    onCancel()
  }, [stopRecording, onCancel])

  const openSettings = useCallback(() => {
    setError('Please enable microphone access in your system settings, then try again.')
  }, [])

  if (state === 'idle' && !error) {
    return (
      <Button
        variant="ghost"
        size="icon"
        onClick={startRecording}
        className={cn('h-8 w-8 text-muted-foreground hover:text-foreground', className)}
        aria-label="Start voice recording"
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
        <span>Requesting microphone access...</span>
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
            <Settings className="size-3 mr-1" />
            Settings
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
        <span>Processing...</span>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-[10px] py-2.5 px-3.5',
        'bg-muted-foreground/[0.04] border border-muted-foreground/15',
        className
      )}
    >
      <div className="flex items-center justify-center shrink-0 size-2.5">
        <div className="rounded-sm bg-muted-foreground shrink-0 size-2 animate-pulse" />
      </div>

      <div className="shrink-0 w-11 font-mono font-medium text-sm/[18px] text-foreground tabular-nums">
        {formatTime(duration)}
      </div>

      <div className="flex items-center grow h-7 gap-0.5">
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
        onClick={handleCancel}
        className={cn(
          'flex items-center shrink-0 rounded-md py-1 px-2.5 gap-1',
          'border border-border/50 text-muted-foreground',
          'hover:bg-muted/50 transition-colors'
        )}
        aria-label="Cancel recording"
      >
        <X className="size-3" />
        <span className="text-[11px]/3.5 font-normal">Cancel</span>
      </button>

      <button
        onClick={handleStop}
        className={cn(
          'flex items-center shrink-0 rounded-md py-1 px-3 gap-1.5',
          'bg-foreground text-background',
          'hover:bg-foreground/90 transition-colors'
        )}
        aria-label="Stop recording"
      >
        <Square className="size-2.5 fill-current" />
        <span className="text-[11px]/3.5 font-medium">Stop</span>
      </button>
    </div>
  )
}
