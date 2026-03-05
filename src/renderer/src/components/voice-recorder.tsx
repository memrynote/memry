/**
 * Voice Recorder Component
 *
 * A component for recording voice memos using the Web MediaRecorder API.
 * Features:
 * - Permission request handling with settings link
 * - Recording timer with max duration enforcement (5 minutes)
 * - Stop and cancel controls
 * - WebM audio output
 *
 * @module components/voice-recorder
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { Mic, Square, X, Loader2, Settings, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:VoiceRecorder')

// ============================================================================
// Types
// ============================================================================

type RecordingState = 'idle' | 'requesting-permission' | 'recording' | 'processing'

interface VoiceRecorderProps {
  /** Called when recording is complete with the audio blob and duration */
  onRecordingComplete: (audioBlob: Blob, duration: number) => void
  /** Called when recording is cancelled */
  onCancel: () => void
  /** Maximum recording duration in seconds (default: 300 = 5 minutes) */
  maxDuration?: number
  /** Start recording immediately on mount */
  autoStart?: boolean
  /** Additional CSS classes */
  className?: string
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_DURATION = 300 // 5 minutes
const MIME_TYPE = 'audio/webm'

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format seconds as MM:SS
 */
function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

// ============================================================================
// Component
// ============================================================================

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

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<number | null>(null)
  const startTimeRef = useRef<number>(0)

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopRecording(true)
    }
  }, [])

  // Auto-start recording on mount
  useEffect(() => {
    if (autoStart && state === 'idle') {
      void startRecording()
    }
  }, [autoStart])

  /**
   * Stop recording and clean up resources
   */
  const stopRecording = useCallback((cancelled = false) => {
    // Clear timer
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }

    // Stop media recorder
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
    }

    // Stop all tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    // If cancelled, don't process the audio
    if (cancelled) {
      chunksRef.current = []
      setState('idle')
      setDuration(0)
    }
  }, [])

  /**
   * Start recording
   */
  const startRecording = useCallback(async () => {
    setError(null)
    setPermissionDenied(false)
    setState('requesting-permission')

    try {
      // Request microphone permission
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100
        }
      })

      streamRef.current = stream
      chunksRef.current = []

      // Create MediaRecorder
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported(MIME_TYPE) ? MIME_TYPE : 'audio/webm'
      })

      mediaRecorderRef.current = mediaRecorder

      // Handle data available
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }

      // Handle recording stop
      mediaRecorder.onstop = () => {
        if (chunksRef.current.length > 0) {
          setState('processing')

          // Create blob from chunks
          const blob = new Blob(chunksRef.current, { type: MIME_TYPE })
          const finalDuration = (Date.now() - startTimeRef.current) / 1000

          // Clean up
          chunksRef.current = []

          // Notify parent
          onRecordingComplete(blob, finalDuration)

          setState('idle')
          setDuration(0)
        } else {
          setState('idle')
          setDuration(0)
        }
      }

      // Handle errors
      mediaRecorder.onerror = (event) => {
        log.error('MediaRecorder error', event)
        setError('Recording error occurred')
        stopRecording(true)
      }

      // Start recording
      mediaRecorder.start()
      startTimeRef.current = Date.now()
      setState('recording')
      setDuration(0)

      // Start duration timer
      timerRef.current = window.setInterval(() => {
        const elapsed = (Date.now() - startTimeRef.current) / 1000
        setDuration(elapsed)

        // Auto-stop at max duration
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
  }, [maxDuration, onRecordingComplete, stopRecording])

  /**
   * Handle stop button click
   */
  const handleStop = useCallback(() => {
    stopRecording(false)
  }, [stopRecording])

  /**
   * Handle cancel button click
   */
  const handleCancel = useCallback(() => {
    stopRecording(true)
    onCancel()
  }, [stopRecording, onCancel])

  /**
   * Open system settings (platform-specific)
   */
  const openSettings = useCallback(() => {
    // On Electron, we can't directly open system settings,
    // but we can show instructions
    setError('Please enable microphone access in your system settings, then try again.')
  }, [])

  // Render based on state
  if (state === 'idle' && !error) {
    // Initial state - show start button
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
          'flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/50',
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
          'flex items-center gap-2 px-3 py-2 rounded-lg bg-destructive/10',
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
          'flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/50',
          'text-sm text-muted-foreground',
          className
        )}
      >
        <Loader2 className="size-4 animate-spin" />
        <span>Processing...</span>
      </div>
    )
  }

  // Recording state
  return (
    <div
      className={cn(
        'flex items-center gap-3 px-3 py-2 rounded-lg',
        'bg-red-500/10 border border-red-500/20',
        className
      )}
    >
      {/* Recording indicator */}
      <div className="flex items-center gap-2">
        <div className="size-2 rounded-full bg-red-500 animate-pulse" aria-hidden="true" />
        <span className="text-sm font-medium text-red-600 dark:text-red-400">Recording</span>
      </div>

      {/* Timer */}
      <div className="text-sm text-muted-foreground tabular-nums">
        {formatTime(duration)} / {formatTime(maxDuration)}
      </div>

      {/* Progress bar */}
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-red-500 transition-all duration-100"
          style={{ width: `${Math.min((duration / maxDuration) * 100, 100)}%` }}
        />
      </div>

      {/* Stop button */}
      <Button
        variant="ghost"
        size="icon"
        onClick={handleStop}
        className="h-8 w-8 text-red-600 dark:text-red-400 hover:bg-red-500/10"
        aria-label="Stop recording"
      >
        <Square className="size-4 fill-current" />
      </Button>

      {/* Cancel button */}
      <Button
        variant="ghost"
        size="icon"
        onClick={handleCancel}
        className="h-8 w-8 text-muted-foreground hover:text-foreground"
        aria-label="Cancel recording"
      >
        <X className="size-4" />
      </Button>
    </div>
  )
}
