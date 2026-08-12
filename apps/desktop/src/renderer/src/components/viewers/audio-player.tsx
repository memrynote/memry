/**
 * Audio Player Component
 * Full-featured audio player with play/pause, seek, volume, and time display.
 *
 * @module components/viewers/audio-player
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Volume1,
  SkipBack,
  SkipForward,
  Copy,
  Check
} from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import { useTrackedTimeout } from '@/hooks/use-tracked-timeout'

// ============================================================================
// Types
// ============================================================================

interface AudioPlayerProps {
  /** File path or URL to the audio */
  src: string
  /** File name for display and download */
  fileName?: string
  /** Optional transcript for filed voice memos */
  transcription?: string | null
  /** CSS classes */
  className?: string
}

// ============================================================================
// Utility Functions
// ============================================================================

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

// ============================================================================
// Audio Player Component
// ============================================================================

export function AudioPlayer({
  src,
  fileName = 'Audio',
  transcription,
  className
}: AudioPlayerProps) {
  const { t: tPhaseF } = useT('notes')
  const { t: tInbox } = useT('inbox')
  const audioRef = useRef<HTMLAudioElement>(null)

  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [error, setError] = useState(false)
  const [copied, setCopied] = useState(false)
  const transcript = transcription?.trim()
  // The "copied" badge reset must not outlive the player
  const scheduleTimeout = useTrackedTimeout()

  // Sync audio element with state
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const handleTimeUpdate = () => setCurrentTime(audio.currentTime)
    const handleLoadedMetadata = () => setDuration(audio.duration)
    const handleEnded = () => setIsPlaying(false)
    const handleError = () => setError(true)

    audio.addEventListener('timeupdate', handleTimeUpdate)
    audio.addEventListener('loadedmetadata', handleLoadedMetadata)
    audio.addEventListener('ended', handleEnded)
    audio.addEventListener('error', handleError)

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate)
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata)
      audio.removeEventListener('ended', handleEnded)
      audio.removeEventListener('error', handleError)
    }
  }, [])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return

    if (isPlaying) {
      audio.pause()
    } else {
      void audio.play()
    }
    setIsPlaying(!isPlaying)
  }, [isPlaying])

  const handleSeek = useCallback((value: number[]) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = value[0]
    setCurrentTime(value[0])
  }, [])

  const handleVolumeChange = useCallback((value: number[]) => {
    const audio = audioRef.current
    if (!audio) return
    const newVolume = value[0]
    audio.volume = newVolume
    setVolume(newVolume)
    setIsMuted(newVolume === 0)
  }, [])

  const toggleMute = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return

    if (isMuted) {
      audio.volume = volume || 1
      setIsMuted(false)
    } else {
      audio.volume = 0
      setIsMuted(true)
    }
  }, [isMuted, volume])

  const skipBackward = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = Math.max(0, audio.currentTime - 10)
  }, [])

  const skipForward = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = Math.min(duration, audio.currentTime + 10)
  }, [duration])

  const handleCopyTranscription = async (): Promise<void> => {
    if (transcript) {
      await navigator.clipboard.writeText(transcript)
      setCopied(true)
      scheduleTimeout(() => setCopied(false), 2000)
    }
  }

  const VolumeIcon = isMuted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2

  if (error) {
    return (
      <div
        className={cn('flex h-full items-center justify-center bg-muted/30 rounded-md', className)}
      >
        <div className="text-center p-8">
          <p className="text-destructive font-medium mb-2">
            {tPhaseF('phaseF.componentsViewersAudioPlayer.failedToLoadAudio')}
          </p>
          <p className="text-sm text-muted-foreground">
            {tPhaseF('phaseF.componentsViewersAudioPlayer.theAudioFileCouldNotBePlayed')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex h-full flex-col bg-muted/20 min-h-0', className)}>
      <audio ref={audioRef} src={src} preload="metadata" aria-label={fileName}>
        <track kind="captions" />
      </audio>

      {/* Main content - player first, transcript directly below */}
      <div className="flex-1 min-h-0 overflow-y-auto p-8">
        <div className="mx-auto flex min-h-full w-full max-w-lg flex-col gap-6">
          <div className="space-y-8">
            {/* File name */}
            <div className="text-center">
              <h2 className="text-xl font-semibold truncate">{fileName}</h2>
            </div>

            {/* Progress bar */}
            <div className="space-y-2">
              <Slider
                value={[currentTime]}
                max={duration || 100}
                step={0.1}
                onValueChange={handleSeek}
                className="cursor-pointer"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>

            {/* Controls */}
            <div className="flex items-center justify-center gap-4">
              <Button
                variant="ghost"
                size="lg"
                onClick={skipBackward}
                className="h-12 w-12 p-0"
                title={tPhaseF('phaseF.componentsViewersAudioPlayer.skipBack10s')}
              >
                <SkipBack className="h-6 w-6" />
              </Button>

              <Button
                variant="default"
                size="lg"
                onClick={togglePlay}
                className="h-16 w-16 rounded-full p-0"
              >
                {isPlaying ? <Pause className="h-8 w-8" /> : <Play className="h-8 w-8 ms-1" />}
              </Button>

              <Button
                variant="ghost"
                size="lg"
                onClick={skipForward}
                className="h-12 w-12 p-0"
                title={tPhaseF('phaseF.componentsViewersAudioPlayer.skipForward10s')}
              >
                <SkipForward className="h-6 w-6" />
              </Button>
            </div>

            {/* Volume control */}
            <div className="flex items-center justify-center gap-3">
              <Button variant="ghost" size="sm" onClick={toggleMute} className="h-8 w-8 p-0">
                <VolumeIcon className="h-4 w-4" />
              </Button>
              <Slider
                value={[isMuted ? 0 : volume]}
                max={1}
                step={0.01}
                onValueChange={handleVolumeChange}
                className="w-24 cursor-pointer"
              />
            </div>
          </div>

          {transcript && (
            <section className="border-t border-border pt-4">
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
                  {tInbox('content.transcription')}
                </h3>
                <button
                  type="button"
                  onClick={() => void handleCopyTranscription()}
                  className="ms-auto text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={tInbox('content.copyTranscription')}
                >
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                </button>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                {transcript}
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
