import { useCallback, useEffect, useRef, useState } from 'react'

import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:VoiceCapture')

export type VoiceCaptureState = 'idle' | 'requesting-permission' | 'recording' | 'processing'

/**
 * Failure kinds are returned instead of messages so each surface can translate
 * with its own namespace/tone (inline recorder panel vs. composer toast).
 */
export type VoiceCaptureErrorKind =
  | 'permission-denied'
  | 'no-microphone'
  | 'access-failed'
  | 'start-failed'
  | 'recorder-failed'

export interface VoiceCaptureError {
  kind: VoiceCaptureErrorKind
  cause: unknown
}

interface UseVoiceCaptureOptions {
  onComplete: (audioBlob: Blob, duration: number) => void
  onError: (error: VoiceCaptureError) => void
  maxDuration?: number
}

export interface VoiceCapture {
  state: VoiceCaptureState
  /** Elapsed seconds of the active recording. */
  duration: number
  /** Live microphone stream while recording, for waveform analysis. */
  stream: MediaStream | null
  start: () => Promise<void>
  /** Stop and deliver the recording through `onComplete`. */
  stop: () => void
  /** Stop and discard the recording. */
  cancel: () => void
}

export const VOICE_CAPTURE_MAX_DURATION = 300
const MIME_TYPE = 'audio/webm'

function toCaptureError(cause: unknown): VoiceCaptureError {
  if (cause instanceof DOMException) {
    if (cause.name === 'NotAllowedError' || cause.name === 'PermissionDeniedError') {
      return { kind: 'permission-denied', cause }
    }
    if (cause.name === 'NotFoundError') {
      return { kind: 'no-microphone', cause }
    }
    return { kind: 'access-failed', cause }
  }
  return { kind: 'start-failed', cause }
}

/**
 * Microphone capture mechanics shared by the inbox voice recorder and the
 * agent composer's dictation button: permission request, MediaRecorder wiring,
 * chunk collection, max-duration cap, and stream teardown.
 */
export function useVoiceCapture(options: UseVoiceCaptureOptions): VoiceCapture {
  const optionsRef = useRef(options)
  optionsRef.current = options

  const [state, setState] = useState<VoiceCaptureState>('idle')
  const [duration, setDuration] = useState(0)
  const [stream, setStream] = useState<MediaStream | null>(null)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const cancelledRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const startTimeRef = useRef<number>(0)

  /**
   * Hand the microphone back to the OS. `getUserMedia` turns the mic on before
   * the recorder is built, so any path that abandons a stream has to stop every
   * track — otherwise the mic stays hot with no UI saying it is recording.
   */
  const releaseStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    setStream(null)
  }, [])

  const stopRecording = useCallback((cancelled: boolean) => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }

    // The recorder runs without a timeslice, so the whole recording arrives as a
    // single `dataavailable` fired *after* `stop()` returns. Latch the discard
    // before stopping so those late callbacks never resurrect the audio — a
    // cancelled memo must never reach the vault or the transcriber.
    if (cancelled) {
      cancelledRef.current = true
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    setStream(null)

    if (cancelled) {
      chunksRef.current = []
      setState('idle')
      setDuration(0)
    }
  }, [])

  const start = useCallback(async () => {
    setState('requesting-permission')

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100
        }
      })

      // Overwriting the ref while an earlier stream is still live would strand
      // it: nothing else holds a reference, so it could never be stopped.
      releaseStream()

      streamRef.current = mediaStream
      chunksRef.current = []
      cancelledRef.current = false

      const mediaRecorder = new MediaRecorder(mediaStream, {
        mimeType: MediaRecorder.isTypeSupported(MIME_TYPE) ? MIME_TYPE : 'audio/webm'
      })

      mediaRecorderRef.current = mediaRecorder

      mediaRecorder.ondataavailable = (event) => {
        if (cancelledRef.current) return
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }

      mediaRecorder.onstop = () => {
        if (cancelledRef.current) {
          chunksRef.current = []
          return
        }

        if (chunksRef.current.length > 0) {
          setState('processing')

          const blob = new Blob(chunksRef.current, { type: MIME_TYPE })
          const finalDuration = (Date.now() - startTimeRef.current) / 1000

          chunksRef.current = []
          optionsRef.current.onComplete(blob, finalDuration)
        }

        setState('idle')
        setDuration(0)
      }

      mediaRecorder.onerror = (event) => {
        log.error('MediaRecorder error', event)
        optionsRef.current.onError({ kind: 'recorder-failed', cause: event })
        stopRecording(true)
      }

      mediaRecorder.start()
      startTimeRef.current = Date.now()
      setState('recording')
      setDuration(0)
      setStream(mediaStream)

      const maxDuration = optionsRef.current.maxDuration ?? VOICE_CAPTURE_MAX_DURATION
      timerRef.current = window.setInterval(() => {
        const elapsed = (Date.now() - startTimeRef.current) / 1000
        setDuration(elapsed)

        if (elapsed >= maxDuration) {
          stopRecording(false)
        }
      }, 100)
    } catch (err) {
      log.error('Failed to start recording', err)
      // `getUserMedia` may have already succeeded before the MediaRecorder
      // constructor or `start()` threw, so release the mic before going idle.
      releaseStream()
      mediaRecorderRef.current = null
      optionsRef.current.onError(toCaptureError(err))
      setState('idle')
    }
  }, [releaseStream, stopRecording])

  const stop = useCallback(() => stopRecording(false), [stopRecording])
  const cancel = useCallback(() => stopRecording(true), [stopRecording])

  useEffect(() => {
    return () => {
      stopRecording(true)
    }
  }, [stopRecording])

  return { state, duration, stream, start, stop, cancel }
}
