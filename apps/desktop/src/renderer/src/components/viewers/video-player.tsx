/**
 * Video Player Component
 * Full-featured video player using react-player library.
 *
 * @module components/viewers/video-player
 */

import {
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  forwardRef,
  useRef,
  type ForwardedRef
} from 'react'
import ReactPlayer from 'react-player'
import { cn } from '@/lib/utils'
import { createLogger } from '@/lib/logger'
import { useT } from '@memry/i18n/renderer'
import { useTabEntityViewState } from '@/hooks/use-tab-entity-view-state'
import {
  FILE_VIEW_STATE_KEYS,
  parsePlaybackPosition,
  shouldResumePlayback
} from '@/pages/file-view-state'

const log = createLogger('Component:VideoPlayer')

const assignForwardedRef = (
  ref: ForwardedRef<HTMLVideoElement>,
  value: HTMLVideoElement | null
): void => {
  if (typeof ref === 'function') {
    ref(value)
  } else if (ref) {
    ref.current = value
  }
}

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
      width: _width,
      height: _height,
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
    const { t } = useT('common')
    const videoRef = useRef<HTMLVideoElement | null>(null)
    const setVideoRef = useCallback(
      (video: HTMLVideoElement | null): void => {
        videoRef.current = video
        assignForwardedRef(ref, video)
      },
      [ref]
    )

    useLayoutEffect(() => {
      const video = videoRef.current
      if (!video) return

      if (playing) {
        video.play().catch(() => {})
      } else {
        video.pause()
      }
    }, [playing])

    useLayoutEffect(() => {
      const video = videoRef.current
      if (!video || volume === null || volume === undefined) return
      video.volume = volume
    }, [volume])

    useLayoutEffect(() => {
      const video = videoRef.current
      if (!video || !playbackRate) return
      video.playbackRate = playbackRate
    }, [playbackRate])

    const handleLoadedMetadata = useCallback(() => {
      const video = videoRef.current
      if (video && onDuration) {
        onDuration(video.duration)
      }
      onReady?.()
    }, [onDuration, onReady])

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
    }, [onProgress])

    return (
      <video
        ref={setVideoRef}
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
        aria-label={t('media.video')}
      >
        <track kind="captions" />
      </video>
    )
  }
)

MemryFilePlayer.displayName = 'MemryFilePlayer'

// Static method to determine if this player can handle the URL
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(MemryFilePlayer as any).canPlay = (src: string) => {
  return src?.startsWith('memry-file://')
}

// Register custom player for memry-file:// protocol — done at module load
// time so the VideoPlayer doesn't need a registration effect.
let customPlayerRegistered = false
function ensureCustomPlayerRegistered(): void {
  if (!customPlayerRegistered) {
    ReactPlayer.addCustomPlayer?.(MemryFilePlayer as never)
    customPlayerRegistered = true
  }
}
ensureCustomPlayerRegistered()

// ============================================================================
// Video Player Component
// ============================================================================

export function VideoPlayer({ src, className }: VideoPlayerProps) {
  const { t: tPhaseF } = useT('notes')
  const [error, setError] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // The position was only ever read off the element and dropped. It is lifted
  // here through the CONTAINER rather than through ReactPlayer's props: the
  // `<video>` is mounted by a custom player ReactPlayer instantiates, so there
  // is no stable prop contract to hang this on. Media events do not bubble, but
  // capture-phase listeners on an ancestor still see them.
  const [storedPosition, setStoredPosition] = useTabEntityViewState<number>({
    key: FILE_VIEW_STATE_KEYS.videoPosition,
    defaultValue: 0,
    parse: parsePlaybackPosition
  })
  const storedPositionRef = useRef(storedPosition)
  const livePositionRef = useRef(storedPosition)
  const setStoredPositionRef = useRef(setStoredPosition)
  useLayoutEffect(() => {
    setStoredPositionRef.current = setStoredPosition
  })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    const commitPosition = (): void => {
      const next = livePositionRef.current
      if (next === storedPositionRef.current) return
      storedPositionRef.current = next
      setStoredPositionRef.current(next)
    }

    const handleLoadedMetadata = (event: Event): void => {
      const video = event.target as HTMLVideoElement
      if (shouldResumePlayback(storedPositionRef.current, video.duration)) {
        video.currentTime = storedPositionRef.current
      }
    }
    const handleTimeUpdate = (event: Event): void => {
      livePositionRef.current = (event.target as HTMLVideoElement).currentTime
    }

    container.addEventListener('loadedmetadata', handleLoadedMetadata, true)
    container.addEventListener('timeupdate', handleTimeUpdate, true)
    container.addEventListener('pause', commitPosition, true)
    return () => {
      container.removeEventListener('loadedmetadata', handleLoadedMetadata, true)
      container.removeEventListener('timeupdate', handleTimeUpdate, true)
      container.removeEventListener('pause', commitPosition, true)
      commitPosition()
    }
  }, [])

  const handleError = useCallback(() => {
    setError(true)
    log.error('Error loading video', src)
  }, [src])

  if (error) {
    return (
      <div
        className={cn('flex h-full items-center justify-center bg-muted/30 rounded-md', className)}
      >
        <div className="text-center p-8">
          <p className="text-destructive font-medium mb-2">
            {tPhaseF('phaseF.componentsViewersVideoPlayer.failedToLoadVideo')}
          </p>
          <p className="text-sm text-muted-foreground">
            {tPhaseF('phaseF.componentsViewersVideoPlayer.theVideoFileCouldNotBePlayed')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={cn('flex h-full flex-col bg-black min-h-0 overflow-hidden', className)}
    >
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
