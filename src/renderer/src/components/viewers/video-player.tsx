/**
 * Video Player Component
 * Full-featured video player using react-player library.
 *
 * @module components/viewers/video-player
 */

import { useState, useCallback, useEffect, forwardRef } from 'react'
import ReactPlayer from 'react-player'
import { cn } from '@/lib/utils'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:VideoPlayer')

// ============================================================================
// Types
// ============================================================================

interface VideoPlayerProps {
  /** File path or URL to the video */
  src: string
  /** CSS classes */
  className?: string
}

// ============================================================================
// Custom Player for memry-file:// protocol
// ============================================================================

interface MemryFilePlayerProps {
  src: string
  playing?: boolean
  loop?: boolean
  controls?: boolean
  muted?: boolean
  volume?: number | null
  playbackRate?: number
  width?: string | number
  height?: string | number
  onReady?: () => void
  onStart?: () => void
  onPlay?: () => void
  onPause?: () => void
  onEnded?: () => void
  onError?: () => void
  onProgress?: (state: {
    played: number
    playedSeconds: number
    loaded: number
    loadedSeconds: number
  }) => void
  onDuration?: (duration: number) => void
}

const MemryFilePlayer = forwardRef<HTMLVideoElement, MemryFilePlayerProps>(
  (
    {
      src,
      playing,
      loop,
      controls,
      muted,
      volume,
      playbackRate,
      width,
      height,
      onReady,
      onStart,
      onPlay,
      onPause,
      onEnded,
      onError,
      onProgress,
      onDuration
    },
    ref
  ) => {
    const videoRef = (ref as React.RefObject<HTMLVideoElement>) || { current: null }

    useEffect(() => {
      const video = videoRef.current
      if (!video) return

      if (playing) {
        video.play().catch(() => {})
      } else {
        video.pause()
      }
    }, [playing, videoRef])

    useEffect(() => {
      const video = videoRef.current
      if (!video || volume === null || volume === undefined) return
      video.volume = volume
    }, [volume, videoRef])

    useEffect(() => {
      const video = videoRef.current
      if (!video || !playbackRate) return
      video.playbackRate = playbackRate
    }, [playbackRate, videoRef])

    const handleLoadedMetadata = useCallback(() => {
      const video = videoRef.current
      if (video && onDuration) {
        onDuration(video.duration)
      }
      onReady?.()
    }, [onDuration, onReady, videoRef])

    const handleTimeUpdate = useCallback(() => {
      const video = videoRef.current
      if (!video || !onProgress) return
      onProgress({
        played: video.currentTime / video.duration || 0,
        playedSeconds: video.currentTime,
        loaded:
          video.buffered.length > 0
            ? video.buffered.end(video.buffered.length - 1) / video.duration
            : 0,
        loadedSeconds: video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) : 0
      })
    }, [onProgress, videoRef])

    return (
      <video
        ref={ref}
        src={src}
        controls={controls}
        loop={loop}
        muted={muted}
        style={{
          width: '100%',
          height: '100%',
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain'
        }}
        onLoadedMetadata={handleLoadedMetadata}
        onPlay={() => {
          onStart?.()
          onPlay?.()
        }}
        onPause={onPause}
        onEnded={onEnded}
        onError={onError}
        onTimeUpdate={handleTimeUpdate}
        playsInline
      />
    )
  }
)

MemryFilePlayer.displayName = 'MemryFilePlayer'

// Static method to determine if this player can handle the URL
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(MemryFilePlayer as any).canPlay = (src: string) => {
  return src?.startsWith('memry-file://')
}

// Register custom player for memry-file:// protocol
let customPlayerRegistered = false
function ensureCustomPlayerRegistered() {
  if (!customPlayerRegistered) {
    ReactPlayer.addCustomPlayer?.(MemryFilePlayer as never)
    customPlayerRegistered = true
  }
}

// ============================================================================
// Video Player Component
// ============================================================================

export function VideoPlayer({ src, className }: VideoPlayerProps) {
  const [error, setError] = useState(false)

  // Register custom player on mount
  useEffect(() => {
    ensureCustomPlayerRegistered()
  }, [])

  const handleError = useCallback(() => {
    setError(true)
    log.error('Error loading video', src)
  }, [src])

  if (error) {
    return (
      <div
        className={cn('flex h-full items-center justify-center bg-muted/30 rounded-lg', className)}
      >
        <div className="text-center p-8">
          <p className="text-destructive font-medium mb-2">Failed to load video</p>
          <p className="text-sm text-muted-foreground">The video file could not be played.</p>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex h-full flex-col bg-black min-h-0 overflow-hidden', className)}>
      <div className="flex-1 min-h-0 flex items-center justify-center">
        <ReactPlayer
          src={src}
          controls
          width="100%"
          height="100%"
          playing={false}
          playsInline
          onError={handleError}
          style={{ maxWidth: '100%', maxHeight: '100%' }}
        />
      </div>
    </div>
  )
}
