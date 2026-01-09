/**
 * Video Player Component
 * Full-featured video player using react-player library.
 *
 * @module components/viewers/video-player
 */

import { useState, useCallback } from 'react'
import ReactPlayer from 'react-player'
import { cn } from '@/lib/utils'

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
// Video Player Component
// ============================================================================

export function VideoPlayer({ src, className }: VideoPlayerProps) {
  const [error, setError] = useState(false)

  const handleError = useCallback(() => {
    setError(true)
    console.error('[VideoPlayer] Error loading video:', src)
  }, [src])


  if (error) {
    return (
      <div
        className={cn(
          'flex h-full items-center justify-center bg-muted/30 rounded-lg',
          className
        )}
      >
        <div className="text-center p-8">
          <p className="text-destructive font-medium mb-2">Failed to load video</p>
          <p className="text-sm text-muted-foreground">The video file could not be played.</p>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex h-full flex-col bg-black', className)}>
      <div className="relative flex-1 w-full h-full">
        <ReactPlayer
          src={src}
          controls
          width="100%"
          height="100%"
          playing={false}
          playsInline
          onReady={handleReady}
          onError={handleError}
        />
      </div>
    </div>
  )
}
