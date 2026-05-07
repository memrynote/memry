import { useRef, useEffect } from 'react'
import type { SceneProps } from '../types'

interface VideoSceneProps extends SceneProps {
  src: string
}

export function VideoScene({ src, playing, onDurationDetected }: VideoSceneProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const playingRef = useRef(playing)

  useEffect(() => {
    playingRef.current = playing
  }, [playing])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    if (playing) {
      const attemptPlay = () => video.play().catch(() => {})

      if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        attemptPlay()
      } else {
        video.addEventListener('canplay', attemptPlay, { once: true })
        return () => video.removeEventListener('canplay', attemptPlay)
      }
    } else {
      video.pause()
    }
  }, [playing])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !onDurationDetected || !video.duration) return
    onDurationDetected(video.duration * 1000)
  }, [onDurationDetected])

  const handleLoadedMetadata = () => {
    const video = videoRef.current
    if (!video || !onDurationDetected) return
    onDurationDetected(video.duration * 1000)
  }

  const handleCanPlay = () => {
    const video = videoRef.current
    if (!video || !playingRef.current) return
    video.play().catch(() => {})
  }

  return (
    <div className="overflow-hidden rounded-lg">
      <video
        ref={videoRef}
        src={src}
        muted
        loop
        playsInline
        preload="auto"
        className="w-full h-auto scale-[1.02]"
        onLoadedMetadata={handleLoadedMetadata}
        onCanPlay={handleCanPlay}
      />
    </div>
  )
}
