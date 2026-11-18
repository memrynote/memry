import { useCallback, useEffect, useRef, useState } from 'react'

import { createLogger } from '@/lib/logger'
import { startPcmCapture, type PcmCapture } from '@/lib/pcm-capture'

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
  onComplete: (audio: AudioBuffer, duration: number) => void
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

interface CaptureSession {
  capture: PcmCapture
  startedAt: number
  stopping: boolean
}

/**
 * Microphone capture mechanics shared by the inbox voice recorder and the
 * agent composer's dictation button: permission request, PCM capture through
 * `startPcmCapture`, max-duration cap, and stream teardown.
 */
export function useVoiceCapture(options: UseVoiceCaptureOptions): VoiceCapture {
  const optionsRef = useRef(options)
  // oxlint-disable-next-line react/refs -- latest-value ref (callbacks/state mirrored for stable handlers); not render output
  optionsRef.current = options

  const [state, setState] = useState<VoiceCaptureState>('idle')
  const [duration, setDuration] = useState(0)
  const [stream, setStream] = useState<MediaStream | null>(null)

  const sessionRef = useRef<CaptureSession | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<number | null>(null)
  /**
   * Bumped by every start, stop, cancel and unmount. A start that finds it
   * changed after an `await` was abandoned (the user left or cancelled while
   * the permission prompt or the graph build was pending) and must not go live.
   */
  const attemptRef = useRef(0)

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  /**
   * Hand the microphone back to the OS. `getUserMedia` turns the mic on before
   * the capture graph is built, so any path that abandons a stream has to stop
   * every track — otherwise the mic stays hot with no UI saying it is recording.
   */
  const releaseStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    setStream(null)
  }, [])

  const stopRecording = useCallback(
    (cancelled: boolean) => {
      attemptRef.current += 1
      clearTimer()
      releaseStream()

      const session = sessionRef.current
      // With no live session the stop landed during the prompt or the graph
      // build: the bumped attempt abandons that start, so it is a cancel.
      if (cancelled || !session) {
        // Dropping the session first means a stop already in flight resolves
        // into nothing: a cancelled memo must never reach the vault or the
        // transcriber.
        sessionRef.current = null
        session?.capture.cancel()
        setState('idle')
        setDuration(0)
        return
      }

      if (session.stopping) return
      session.stopping = true

      void session.capture.stop().then(
        (audio) => {
          if (sessionRef.current !== session) return
          sessionRef.current = null
          if (audio) {
            setState('processing')
            optionsRef.current.onComplete(audio, (Date.now() - session.startedAt) / 1000)
          }
          setState('idle')
          setDuration(0)
        },
        (err: unknown) => {
          if (sessionRef.current !== session) return
          sessionRef.current = null
          log.error('Voice capture stop failed', err)
          optionsRef.current.onError({ kind: 'recorder-failed', cause: err })
          setState('idle')
          setDuration(0)
        }
      )
    },
    [clearTimer, releaseStream]
  )

  const start = useCallback(async () => {
    const attempt = ++attemptRef.current
    const abandoned = (): boolean => attempt !== attemptRef.current

    // A start while recording replaces that recording. Its timer, stream and
    // capture go first: nothing else holds them, so they could never be stopped.
    clearTimer()
    releaseStream()
    sessionRef.current?.capture.cancel()
    sessionRef.current = null
    setState('requesting-permission')

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100
        }
      })

      if (abandoned()) {
        mediaStream.getTracks().forEach((track) => track.stop())
        return
      }

      streamRef.current = mediaStream

      let session: CaptureSession | null = null
      const capture = await startPcmCapture(mediaStream, (cause) => {
        if (!session || sessionRef.current !== session) return
        log.error('Voice capture processor error', cause)
        optionsRef.current.onError({ kind: 'recorder-failed', cause })
        stopRecording(true)
      })

      // The stop, cancel or new start that abandoned this attempt already
      // released its stream; the capture goes with it.
      if (abandoned()) {
        capture.cancel()
        return
      }

      const active: CaptureSession = { capture, startedAt: Date.now(), stopping: false }
      session = active
      sessionRef.current = active
      setState('recording')
      setDuration(0)
      setStream(mediaStream)

      const maxDuration = optionsRef.current.maxDuration ?? VOICE_CAPTURE_MAX_DURATION
      timerRef.current = window.setInterval(() => {
        const elapsed = (Date.now() - active.startedAt) / 1000
        setDuration(elapsed)

        if (elapsed >= maxDuration) {
          stopRecording(false)
        }
      }, 100)
    } catch (err) {
      // An abandoned attempt's stream was released by whatever abandoned it,
      // and its user no longer waits for this start.
      if (abandoned()) return
      log.error('Failed to start recording', err)
      // `getUserMedia` may have already succeeded before the capture graph
      // failed to build, so release the mic before going idle.
      releaseStream()
      optionsRef.current.onError(toCaptureError(err))
      setState('idle')
    }
  }, [clearTimer, releaseStream, stopRecording])

  const stop = useCallback(() => stopRecording(false), [stopRecording])
  const cancel = useCallback(() => stopRecording(true), [stopRecording])

  useEffect(() => {
    return () => {
      stopRecording(true)
    }
  }, [stopRecording])

  return { state, duration, stream, start, stop, cancel }
}
